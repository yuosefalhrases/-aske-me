async function generateQuiz() {
  const fileInput = document.getElementById('fileInput'); // غير اسم الـ ID حسب ملفك
  if (!fileInput.files[0]) {
    alert("يرجى اختيار ملف أولاً");
    return;
  }

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('count', '10');
  formData.append('difficulty', 'Medium');

  try {
    const response = await fetch('/api/generate-quiz', {
      method: 'POST',
      body: formData
    });

    // لقراءة الاستجابة كنص أولاً لتفادي كراش المتصفح عند إرجاع HTML أو نص خاطئ
    const rawText = await response.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error("Non-JSON Response received:", rawText);
      throw new Error("حدث خطأ في الخادم أثناء معالجة الملف. يرجى إعادة المحاولة.");
    }

    if (!response.ok) {
      throw new Error(data.error || `خطأ في الخادم (${response.status})`);
    }

    // هنا يتم معالجة البيانات بنجاح
    console.log("Quiz Data Received:", data);
    renderQuiz(data);

  } catch (error) {
    console.error("Fetch Error:", error);
    alert(error.message);
  }
}
