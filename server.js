import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import OpenAI from "openai";

const app=express();
const upload=multer({dest:"uploads/",limits:{fileSize:20*1024*1024}});
const port=process.env.PORT||3000;
app.use(express.static("."));

async function pptxText(filePath){
 const zip=await JSZip.loadAsync(await fs.promises.readFile(filePath));
 const names=Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
 let out=[];
 for(const n of names){const xml=await zip.files[n].async("text");const t=[...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m=>m[1]);if(t.length)out.push(`[${n}]\n${t.join(" ")}`)}
 return out.join("\n");
}
async function extract(file){
 const ext=path.extname(file.originalname).toLowerCase();
 if(ext===".pdf"){
  const parser=new PDFParse({data:await fs.promises.readFile(file.path)});
  try{const r=await parser.getText();return r.text}
  finally{await parser.destroy()}
}
 if(ext===".docx"){const r=await mammoth.extractRawText({path:file.path});return r.value}
 if(ext===".pptx")return pptxText(file.path);
 throw new Error("This first online build supports PDF, DOCX and PPTX.");
}
const schema={type:"object",additionalProperties:false,properties:{questions:{type:"array",items:{type:"object",additionalProperties:false,properties:{
 question:{type:"string"},options:{type:"array",items:{type:"string"}},correct_answer:{type:"integer"},explanation:{type:"string"},
 difficulty:{type:"string",enum:["Easy","Medium","Hard"]},cognitive_level:{type:"string",enum:["Recall","Understanding","Application","Integration"]},
 topic:{type:"string"},source:{type:"string"}},required:["question","options","correct_answer","explanation","difficulty","cognitive_level","topic","source"]}}},required:["questions"]};

app.post("/api/generate-quiz",upload.single("file"),async(req,res)=>{
 let p;
 try{
  if(!req.file)return res.status(400).json({error:"No file uploaded."});p=req.file.path;
  const count=Math.min(Math.max(parseInt(req.body.count||"10"),1),50);
  const difficulty=["Easy","Medium","Hard"].includes(req.body.difficulty)?req.body.difficulty:"Medium";
  const material=(await extract(req.file)).slice(0,180000);
  if(material.trim().length<100)return res.status(400).json({error:"Not enough readable text."});
  if(!process.env.OPENAI_API_KEY)return res.status(500).json({error:"Server AI key is not configured."});
  const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
  const prompt=`You are the aske me question engine.

SOURCE MATERIAL:
${material}

Generate exactly ${count} MCQs at ${difficulty} difficulty.

Use ONLY the source material. Do not add outside facts.
Prioritize understanding, application and integration when supported.
A clinical-looking scenario is not automatically application.
Avoid questions solvable only by keyword matching when a reasoning task is possible.
Difficulty must come from reasoning, not ambiguity.
Exactly 4 options and exactly one best answer per question.
Distractors must be plausible but clearly wrong from the source.
Avoid trick wording, all/none of the above, irrelevant clues and duplicates.
Distinguish what evidence supports from what is merely possible.
Keep the source terminology.
Give a concise explanation and identify the relevant topic/source section or slide if inferable.
Silently verify every question before returning it.`;
  const out=await client.responses.create({model:"gpt-5.6-luna",input:prompt,text:{format:{type:"json_schema",name:"aske_me_quiz",strict:true,schema}}});
  res.json(JSON.parse(out.output_text));
 }catch(e){console.error(e);res.status(500).json({error:e.message||"Generation failed."})}
 finally{if(p)fs.promises.unlink(p).catch(()=>{})}
});
app.get("/api/health",(req,res)=>res.json({ok:true}));
app.listen(port,()=>console.log(`aske me running on port ${port}`));