import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { getData } from "pdf-parse/worker";
import { PDFParse } from "pdf-parse";
import { GoogleGenAI } from "@google/genai";
//===============================
//PDFworker
//===============================

PDFParse.setWorker(getData());

constapp=express();
constPORT=process.env.PORT||3000;

//===============================
//Uploadsettings
//===============================

constupload=multer({
dest:"uploads/",
limits:{
fileSize:100*1024*1024,
},
});

app.use(express.static("."));
app.use(express.json());

//===============================
//ExtractimagesfromDOCX/PPTX
//===============================

async function extractImagesFromZip(filePath){
constimages=[];

try{
constfileBuffer=awaitfs.promises.readFile(filePath);
constzip=awaitJSZip.loadAsync(fileBuffer);

constmediaFiles=Object.keys(zip.files).filter(
(fileName)=>
fileName.startsWith("ppt/media/")||
fileName.startsWith("word/media/")
);

for(const fileName of mediaFiles.slice(0,5)){
constfile=zip.files[fileName];

constimageBuffer=awaitfile.async("nodebuffer");

constext=path
.extname(fileName)
.toLowerCase()
.replace(".","");

letmimeType="image/jpeg";

if(ext==="png"){
mimeType="image/png";
}elseif(ext==="webp"){
mimeType="image/webp";
}elseif(ext==="gif"){
mimeType="image/gif";
}

images.push({
inlineData:{
data:imageBuffer.toString("base64"),
mimeType,
},
});
}
}catch(error){
console.warn(
"[ImageExtraction]Couldnotextractimages:",
error.message
);
}

returnimages;
}

//===============================
//ExtracttextfromPPTX
//===============================

asyncfunctionpptxText(filePath){
constzip=awaitJSZip.loadAsync(
awaitfs.promises.readFile(filePath)
);

constnames=Object.keys(zip.files)
.filter((name)=>
/^ppt\/slides\/slide\d+\.xml$/.test(name)
)
.sort((a,b)=>
a.localeCompare(b,undefined,{
numeric:true,
})
);

constoutput=[];

for(constnameofnames){
constxml=awaitzip.files[name].async("text");

consttextParts=[
...xml.matchAll(
/<a:t>([\s\S]*?)<\/a:t>/g
),
].map((match)=>match[1]);

if(textParts.length){
output.push(
`[${name}]\n${textParts.join("")}`
);
}
}

returnoutput.join("\n");
}

//===============================
//Extractcontentfromfile
//===============================

asyncfunctionextractContentFromFile(file){
constext=path
.extname(file.originalname)
.toLowerCase();

lettext="";
letimages=[];

//=============================
//PDF
//=============================

if(ext===".pdf"){
constdataBuffer=
awaitfs.promises.readFile(file.path);

letparser=null;

try{
parser=newPDFParse({
data:dataBuffer,
});

constresult=awaitparser.getText();

text=result?.text||"";
}finally{
if(parser){
awaitparser.destroy();
}
}
}

//=============================
//DOCX
//=============================

elseif(ext===".docx"){
constresult=
awaitmammoth.extractRawText({
path:file.path,
});

text=result.value||"";

images=
awaitextractImagesFromZip(file.path);
}

//=============================
//PPTX
//=============================

elseif(ext===".pptx"){
text=awaitpptxText(file.path);

images=
awaitextractImagesFromZip(file.path);
}

else{
thrownewError(
"نوعالملفغيرمدعوم.يرجىرفعPDFأوDOCXأوPPTX."
);
}

return{
text,
images,
};
}

//===============================
//QuizJSONSchema
//===============================

constquizResponseSchema={
type:"object",

properties:{
questions:{
type:"array",

items:{
type:"object",

properties:{
question:{
type:"string",
},

options:{
type:"array",
items:{
type:"string",
},
},

correct_answer:{
type:"integer",
},

explanation:{
type:"string",
},

difficulty:{
type:"string",
enum:[
"Easy",
"Medium",
"Hard",
],
},

cognitive_level:{
type:"string",
enum:[
"Recall",
"Understanding",
"Application",
"Integration",
],
},

topic:{
type:"string",
},

source:{
type:"string",
},
},

required:[
"question",
"options",
"correct_answer",
"explanation",
"difficulty",
"cognitive_level",
"topic",
"source",
],
},
},
},

required:["questions"],
};

//===============================
//Sleephelper
//===============================

functionsleep(ms){
returnnewPromise((resolve)=>
setTimeout(resolve,ms)
);
}

//===============================
//Checkiferroristemporary
//===============================

functionisTemporaryGeminiError(error){
constmessage=
error?.message?.toLowerCase()||"";

return(
message.includes("503")||
message.includes("unavailable")||
message.includes("highdemand")||
message.includes("overloaded")||
message.includes("temporarily")
);
}

//===============================
//Geminiwithretry+fallback
//===============================

asyncfunctionexecuteGemini(contents){
if(!process.env.GEMINI_API_KEY){
thrownewError(
"مفتاحGEMINI_API_KEYغيرموجودفيإعداداتالبيئة."
);
}

constai=newGoogleGenAI({
apiKey:process.env.GEMINI_API_KEY,
});

constmodels=[
"gemini-3.6-flash",
"gemini-3.5-flash-lite",
];

letlastError=null;

for(constmodelNameofmodels){
console.log(
`[AIEngine]Tryingmodel:${modelName}`
);

for(letattempt=1;attempt<=3;attempt++){
try{
console.log(
`[AIEngine]Attempt${attempt}/3-${modelName}`
);

constresponse=
awaitai.models.generateContent({
model:modelName,

contents,

config:{
responseMimeType:
"application/json",

responseSchema:
quizResponseSchema,
},
});

console.log(
`[AIEngine]Successwith${modelName}`
);

returnresponse;
}

catch(error){
lastError=error;

console.error(
`[AIError-${modelName}-Attempt${attempt}]:`,
error.message
);

if(isTemporaryGeminiError(error)){
if(attempt<3){
constwaitTime=
attempt===1
?2000
:attempt===2
?5000
:8000;

console.log(
`[AIEngine]Temporaryerror.Waiting${waitTime}ms...`
);

awaitsleep(waitTime);

continue;
}

console.warn(
`[AIEngine]${modelName}isstillunavailable.Tryingfallbackmodel...`
);

break;
}

throwerror;
}
}
}

thrownewError(
`تعذرإنشاءالاختبارحاليًابسببضغطمؤقتعلىخدمةالذكاءالاصطناعي.يرجىالمحاولةمرةأخرىبعدقليل.`
);
}

//===============================
//SafeJSONparser
//===============================

functionsafeParseJSON(rawText){
if(!rawText){
thrownewError(
"استجابةالذكاءالاصطناعيفارغة."
);
}

letcleaned=rawText.trim();

cleaned=cleaned
.replace(/^```json\s*/i,"")
.replace(/^```\s*/i,"")
.replace(/\s*```$/i,"")
.trim();

constfirstOpen=
cleaned.indexOf("{");

constlastClose=
cleaned.lastIndexOf("}");

if(
firstOpen!==-1&&
lastClose!==-1&&
lastClose>firstOpen
){
cleaned=cleaned.substring(
firstOpen,
lastClose+1
);
}

try{
returnJSON.parse(cleaned);
}

catch(error){
console.error(
"[JSONParseError]",
cleaned
);

thrownewError(
"تعذرقراءةاستجابةالذكاءالاصطناعيكـJSON."
);
}
}

//===============================
//GenerateQuiz
//===============================

app.post(
"/api/generate-quiz",
upload.single("file"),
async(req,res)=>{
letuploadedFilePath=null;

try{
if(!req.file){
returnres.status(400).json({
error:
"لميتمرفعأيملف.",
});
}

uploadedFilePath=
req.file.path;

constcount=Math.min(
Math.max(
parseInt(
req.body.count||"10"
),
1
),
50
);

constdifficulty=[
"Easy",
"Medium",
"Hard",
].includes(
req.body.difficulty
)
?req.body.difficulty
:"Medium";

console.log(
`[Quiz]Count:${count},Difficulty:${difficulty}`
);

const{
text,
images,
}=
awaitextractContentFromFile(
req.file
);

constmaterial=
text.slice(0,45000);

console.log(
`[File]Extractedtext:${material.length}chars`
);

console.log(
`[File]Extractedimages:${images.length}`
);

if(
material.trim().length<50&&
images.length===0
){
returnres.status(400).json({
error:
"الملفالمرفوعلايحتويعلىنصأوصوركافيةللتحليل.",
});
}

if(
!process.env.GEMINI_API_KEY
){
returnres.status(500).json({
error:
"مفتاحGEMINI_API_KEYغيرمضاففيإعداداتالبيئة.",
});
}

constpromptText=`
YouaretheAskMequestiongenerationengine.

SOURCEMATERIAL:
${material}

Generateexactly${count}multiple-choicequestions.

Difficulty:
${difficulty}

IMPORTANTRULES:

1.UseONLYtheprovidedsourcematerial.
2.Donotintroduceoutsidefacts.
3.Generateexactly${count}questions.
4.Everyquestionmusthaveexactly4options.
5.TheremustbeexactlyONEcorrectanswer.
6.correct_answermustbea0-basedindex:
0=firstoption
1=secondoption
2=thirdoption
3=fourthoption
7.Explanationsmustbebasedonlyonthesourcematerial.
8.Usetheprovidedimageswhentheycontainusefulinformation.
9.Identifythetopicofeveryquestion.
10.Identifythesource/sectionfromwhichthequestionwasgenerated.
11.Cognitivelevelmustbeoneof:
Recall
Understanding
Application
Integration

ReturnONLYvalidJSONmatchingtheprovidedschema.
`;

constcontents=[
{
role:"user",

parts:[
{
text:promptText,
},

...images.map(
(image)=>({
inlineData:
image.inlineData,
})
),
],
},
];

constapiResponse=
awaitexecuteGemini(
contents
);

constrawText=
apiResponse.text;

console.log(
"[AIEngine]Rawresponselength:",
rawText?.length||0
);

constjsonOutput=
safeParseJSON(
rawText
);

if(
!jsonOutput||
!Array.isArray(
jsonOutput.questions
)
){
thrownewError(
"الذكاءالاصطناعيلميُرجعقائمةأسئلةصحيحة."
);
}

if(
jsonOutput.questions.length!==
count
){
console.warn(
`[AIWarning]Requested${count}questionsbutreceived${jsonOutput.questions.length}`
);
}

returnres.json(
jsonOutput
);
}

catch(error){
console.error(
"[QuizRouteError]:",
error
);

returnres.status(500).json({
error:
error.message||
"حدثخطأغيرمتوقعأثناءإنشاءالاختبار.",
});
}

finally{
if(uploadedFilePath){
fs.promises
.unlink(
uploadedFilePath
)
.catch((error)=>{
console.error(
"فشلحذفالملفالمؤقت:",
error
);
});
}
}
}
);

//===============================
//HealthCheck
//===============================

app.get(
"/api/health",
(req,res)=>{
res.json({
status:"healthy",
timestamp:newDate(),
});
}
);

//===============================
//Startserver
//===============================

app.listen(
PORT,
()=>{
console.log(
`Serverisrunningonport${PORT}`
);
}
);