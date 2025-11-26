import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Code, Image as ImageIcon, Sparkles, X, Play, Copy, Zap, Cpu, ArrowLeft, Camera, Download, Film } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signInAnonymously } from 'firebase/auth';

// Firebase yapılandırması ve yetkilendirme değişkenleri (Canvas ortamından sağlanır)
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// API ve Retry Sabitleri
const IMAGEN_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=`;
const GEMINI_API_KEY = ''; 
const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;

// Firebase ve Auth Yönetimi
// Firestore bu örnekte kullanılmasa bile, Canvas yetkilendirmesi için gereklidir
let app, auth;

if (Object.keys(firebaseConfig).length > 0) {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    if (initialAuthToken) {
      signInWithCustomToken(auth, initialAuthToken).catch(e => console.error("Firebase Custom Auth Hatası:", e));
    } else {
      signInAnonymously(auth).catch(e => console.error("Firebase Anonim Auth Hatası:", e));
    }
  } catch (e) {
    console.error("Firebase başlatma başarısız:", e);
  }
}

// --- Yardımcı Fonksiyonlar ---

/**
 * Üstel geri çekilme (Exponential Backoff) ile tekrar deneme mantığını uygulayan fetch.
 * (API kısıtlamaları veya geçici hatalar için gereklidir.)
 */
async function fetchWithRetry(url, options, maxRetries, initialDelay) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                if (response.status === 429 && i < maxRetries - 1) {
                    const delay = initialDelay * Math.pow(2, i);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                const errorData = await response.json();
                throw new Error(`API Hatası: ${errorData.error?.message || response.statusText}`);
            }
            return response;
        } catch (error) {
            if (i === maxRetries - 1) {
                throw error;
            }
            const delay = initialDelay * Math.pow(2, i);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * Imagen API'yi çağırarak bir görsel üretir.
 * @param {string} promptText - Görseli oluşturmak için kullanılan metin.
 * @returns {string} Base64 kodlu görsel URL'si.
 */
async function generateImage(promptText) {
    const payload = {
        instances: [{ prompt: promptText }],
        parameters: {
            sampleCount: 1,
            outputMimeType: "image/png",
            aspectRatio: "16:9" 
        }
    };

    const response = await fetchWithRetry(IMAGEN_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }, MAX_RETRIES, INITIAL_DELAY_MS);

    const result = await response.json();
    
    if (result.predictions && result.predictions.length > 0 && result.predictions[0].bytesBase64Encoded) {
        return `data:image/png;base64,${result.predictions[0].bytesBase64Encoded}`;
    } else {
        throw new Error("Görsel oluşturma başarısız oldu. Geçerli bir sonuç alınamadı.");
    }
}


// Sadece tarayıcıda çalıştırılabilir (HTML, JS/CSS ile sarmalanmış) kodu döndürür.
const extractCode = (content) => {
  // LaTeX dahil olmayan tüm kod bloklarını ara
  const codeBlockRegex = /```(html|jsx|javascript|js|css|typescript|ts)\n([\s\S]*?)```/g;
  let match;
  let webCode = null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const language = match[1];
    const code = match[2].trim();

    if (language === 'html' || language === 'jsx') {
      return code; 
    } 
    if (['javascript', 'js', 'css', 'ts', 'typescript'].includes(language)) {
        webCode = `<html><head><script src="https://cdn.tailwindcss.com"></script><style>html, body { margin: 0; padding: 0; height: 100%; }</style></head><body><script>${code}</script></body></html>`;
    }
  }
  
  return webCode;
};

// Yanıttaki İLK kod bloğunun dilini ve ham içeriğini döndürür (Kopyalama için kullanılır).
const getPrimaryCodeBlock = (content) => {
    // Regex, dilden bağımsız olarak ilk kod bloğunu yakalar
    const codeBlockRegex = /```(\w+)\n([\s\S]*?)```/g;
    const match = codeBlockRegex.exec(content);
    
    if (match) {
        const language = match[1].toLowerCase();
        const code = match[2].trim();
        return { language, code };
    }
    return null;
};


// --- Ana Uygulama Bileşeni ---

export default function InfinityAIStudio() {
  const [messages, setMessages] = useState([
    { id: 1, role: 'system', content: 'Merhaba! Ben **InfinityAI**. Mod seçimi güncellendi. Artık **Canvas** modunda isteyeceğiniz **herhangi bir dilin** (Python, Java, C#, vb.) görselleştirilebilir çıktısını otomatik olarak HTML/JavaScript\'e çevirip önizleme yapabilirim.', type: 'text' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [currentCode, setCurrentCode] = useState('');
  const [selectedMode, setSelectedMode] = useState('canvas'); 
  const [currentStep, setCurrentStep] = useState(''); 
  const [copyMessage, setCopyMessage] = useState(''); 
  
  const [primaryCodeInfo, setPrimaryCodeInfo] = useState(null); 
  const [showModeSelector, setShowModeSelector] = useState(false);

  // Resim Analizi için Yeni Durumlar (Vision)
  const [imageUrl, setImageUrl] = useState(null); // Önizleme için URL
  const [imageData, setImageData] = useState(null); // Base64 Verisi
  const [imageMimeType, setImageMimeType] = useState(null); // MIME Tipi

  const chatContainerRef = useRef(null);
  const fileInputRef = useRef(null);
  const logoUrl = 'https://raw.githubusercontent.com/ByWerton/InfinityAI/refs/heads/main/1764172777146.png';

  // Mod listesi
  const modes = ['canvas', 'derin_arastirma', 'tek_sefer', 'resim', 'video'];
  
  const handleModeSelect = (mode) => {
    setSelectedMode(mode);
    setShowModeSelector(false); 
    setShowPreview(false);
    setPrimaryCodeInfo(null);
    clearImage(); 
    if (mode === 'video') {
        setInput("Lütfen üç farklı satır kullanarak 3 kare için hikaye açıklamasını girin. (Örn: \n\nKare 1 Açıklaması\n\nKare 2 Açıklaması\n\nKare 3 Açıklaması)");
    } else if (input.includes('Kare 1 Açıklaması')) {
        setInput(''); // Eğer video modundan çıkıyorsa örnek prompt'u temizle
    }
  };
  
  const getModeLabel = (mode) => {
      switch (mode) {
          case 'canvas': return 'Canvas (Çekirdek + Çeviri)';
          case 'derin_arastirma': return 'Derin Araştırma (10 Adım)';
          case 'tek_sefer': return 'Tek Sefer (Hızlı)';
          case 'resim': return 'Resim Çiz (Imagen 4.0)';
          case 'video': return 'Video Oluştur (Simülasyon)'; 
          default: return 'Bilinmiyor';
      }
  };

  // Scroll to bottom
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages]);
  
  // Resim Temizleme
  const clearImage = () => {
    setImageUrl(null);
    setImageData(null);
    setImageMimeType(null);
    if (fileInputRef.current) {
        fileInputRef.current.value = null; 
    }
  };
  
  // Resim Yükleme ve Base64 Dönüşümü
  const handleImageUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result.split(',')[1];
        setImageUrl(reader.result);
        setImageData(base64String);
        setImageMimeType(file.type);
      };
      reader.readAsDataURL(file);
    }
  };

  // Copy Code Function (Uses document.execCommand for iFrame compatibility)
  const copyCodeToClipboard = (rawCode, lang) => {
    const textarea = document.createElement('textarea');

    textarea.value = rawCode;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
        const languageName = lang ? lang.toUpperCase() : 'KOD';
        setCopyMessage(`${languageName} kodu başarıyla panoya kopyalandı!`);
    } catch (err) {
        setCopyMessage('Kopyalama başarısız oldu.');
    }
    document.body.removeChild(textarea);

    setTimeout(() => setCopyMessage(''), 3000);
  };


  // --- API Çağrısı (Vision Desteğiyle) ---

  const callGemini = async (prompt, modelOverride = 'gemini-2.5-flash-preview-09-2025', imagePayload = null) => {
    
    let delay = 1000; 
    const maxRetries = 5;

    const contents = [{ 
      parts: [
        { text: prompt },
        ...(imagePayload ? [{ 
          inlineData: {
            mimeType: imagePayload.mimeType,
            data: imagePayload.data
          }
        }] : [])
      ]
    }];
    
    const apiBody = JSON.stringify({ contents: contents });
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelOverride}:generateContent?key=${GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: apiBody
        });
        
        const data = await response.json();
        
        if (response.status === 429) { 
          if (attempt < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; 
            continue; 
          } else {
            throw new Error('Hata 429: ElevenGalaxy limitini aştınız. Lütfen daha sonra tekrar deneyin.');
          }
        }
        
        if (data.error) throw new Error(data.error.message || `InfinityAI API Hatası: ${response.status}`);
        
        return data.candidates[0].content.parts[0].text;
        
      } catch (error) {
        if (attempt < maxRetries - 1) {
           await new Promise(resolve => setTimeout(resolve, delay));
           delay *= 2;
           continue; 
        }
        throw error;
      }
    }
    throw new Error("API çağrısı tüm denemelerde başarısız oldu.");
  };

  // --- İteratif Analiz İşlemi (10 Aşamalıya kadar) ---
  const runFourStepAnalysis = async (userPrompt, isCodeMode, imagePayload = null) => {
    let currentResponse = '';
    
    const maxSteps = 10; 
    
    const iterativeInstructionBase = "Önceki yanıtı analiz et ve kullanıcının isteğini tam ve mükemmel bir şekilde yerine getirene kadar iyileştirme, hata giderme ve eksiksiz hale getirme sürecine devam et. YAPILMADI VEYOR BAŞARISIZ OLDU gibi olumsuz kelimeler KULLANMA. Her zaman nihai sonuca ulaşıyormuş gibi İLERLE.";

    const apiModelName = 'gemini-2.5-flash-preview-09-2025';

    const htmlOutputMandate = `
        Kullanıcının isteği bir programlama dili çıktısı gerektiriyorsa (Python, Java, C#, vb.), her zaman iki ayrı kod bloğu döndürmelisin: 
        1) İstenen dildeki (**ÇEKİRDEK MANTIK**) kodu. 
        2) Bu çekirdek mantığın tarayıcıda görselleştirilebileceği, Canvas Önizleme için hazır **HTML, JavaScript ve CSS** içeren TEK bir kod bloğu. 
        **ÖNEMLİ:** Eğer kullanıcı görselleştirme istemese bile, 'canvas' modu etkin olduğu sürece, çalıştırılabilir HTML/JavaScript/CSS içeren bir Canvas önizleme kodu **MUTLAKA** oluşturulmalıdır.
    `;

    for (let i = 0; i < maxSteps; i++) {
        let stepPrompt;
        let instruction;

        if (i === 3) {
            instruction = "4. ADIM (Hedef Teslimat): Bu, kullanıcının isteğinin **mükemmel ve eksiksiz** teslimatı olmalıdır. Eğer sonuçtan eminsen, bu çıktıyı ver ve sonraki adımları atla. Aksi takdirde, daha fazla iyileştirme için sonraki adımlara devam et."
        } else if (i === maxSteps - 1) {
            instruction = "SON ADIM: Bu, kullanıcının isteğinin **MÜKEMMEL, EKSİKSİZ VE DOĞRUDAN** teslimatıdır. SON ÇIKTIYI GÖSTER, açıklamaları veya ara adımları atla. Sorun çözülmüş ve teslim edilmiş gibi davran."
        } else if (i > 3) {
             instruction = `Genişletilmiş İyileştirme Adımı (${i + 1}/${maxSteps}): ${iterativeInstructionBase} Üstün bir sonuç için devam ediliyor.`;
        } else {
            instruction = `(${i + 1}/${maxSteps} İyileştirme Adımı): ${iterativeInstructionBase}`;
        }


        if (isCodeMode) {
            const codeOutputInstruction = htmlOutputMandate; 

            stepPrompt = i === 0
                ? `Kullanıcının isteği: "${userPrompt}". ${instruction} ${codeOutputInstruction}`
                : `Kullanıcının orijinal isteği: "${userPrompt}". Önceki adımda üretilen kod taslağı: "${currentResponse}". Lütfen bu kodu değerlendir ve aşağıdaki görevi yerine getir. ${instruction} ${codeOutputInstruction}`;
        } else {
            stepPrompt = i === 0
                ? userPrompt
                : `Kullanıcının orijinal isteği: "${userPrompt}". Önceki adımda üretilen yanıt: "${currentResponse}". Lütfen bu yanıtı değerlendir ve aşağıdaki görevi yerine getir. ${instruction}`;
        }
        
        setCurrentStep(`Adım ${i + 1}/${maxSteps}: ${i === maxSteps - 1 ? "Nihai Teslimat Hazırlanıyor" : "Çıktı İyileştiriliyor..."}`);
        
        const stepResult = await callGemini(stepPrompt, apiModelName, i === 0 ? imagePayload : null);
        currentResponse = stepResult;
        
        if (i === maxSteps - 1) {
             break;
        }

    }
    
    return currentResponse;
  };

  // --- Mesaj Gönderme Mantığı ---

  const handleSend = async () => {
    if (!input.trim() && !imageData) return; 

    const userMsg = { id: Date.now(), role: 'user', content: input, type: 'text' };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);
    setCurrentStep('');
    setPrimaryCodeInfo(null); 
    setShowModeSelector(false); 

    const usedModelName = 'InfinityAI Tech';
    const imagePayload = imageData ? { data: imageData, mimeType: imageMimeType } : null;
    
    if (selectedMode !== 'resim') {
        clearImage(); 
    }

    try {
      if (selectedMode === 'resim') {
        setCurrentStep('Görsel üretimi için model (Imagen 4.0) çağrılıyor...');
        
        const userPrompt = userMsg.content;
        const imageUrl = await generateImage(userPrompt);
        
        const botMsg = { id: Date.now() + 1, role: 'ai', content: imageUrl, type: 'image', model: `Imagen 4.0 (Resim Modu)` };
        setMessages(prev => [...prev, botMsg]);
        
        clearImage(); 
        
      } else if (selectedMode === 'video') {
        // VİDEO OLUŞTURMA MODU (Frame-by-Frame Görsel Dizisi)
        const userPrompt = userMsg.content;
        
        // Girdiyi en az iki boş satırla ayrılmış 3 bölüme ayır
        const promptParts = userPrompt.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
        
        if (promptParts.length !== 3) {
            setError('Video modu için lütfen metninizi en az iki boş satır kullanarak 3 ayrı kareye ayırın. (Örn: Kare 1\n\nKare 2\n\nKare 3)');
            setIsLoading(false);
            return;
        }

        setCurrentStep('3 Kareden oluşan video dizisi üretiliyor...');
        
        const imagePromises = [];
        
        // Her kare için resim üretme isteği
        for(let i = 0; i < promptParts.length; i++) {
            setCurrentStep(`Kare ${i + 1}/3 için görsel üretiliyor: ${promptParts[i].substring(0, 50)}...`);
            imagePromises.push(generateImage(promptParts[i]));
        }

        const imageUrls = await Promise.all(imagePromises);
        
        // 3 resmi gösteren HTML çıktısını oluştur
        const htmlOutput = `
            \`\`\`html:Video Kare Dizisi:video_sequence.html
            <!DOCTYPE html>
            <html lang="tr">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Video Kare Dizisi</title>
                <script src="https://cdn.tailwindcss.com"></script>
                <style>
                    :root { font-family: 'Inter', sans-serif; }
                </style>
            </head>
            <body class="bg-gray-900 min-h-screen p-4 flex items-center justify-center">
                <div class="w-full max-w-7xl mx-auto">
                    <h1 class="text-3xl font-bold text-center text-red-500 mb-8 border-b-2 border-red-700 pb-2">Hikaye Akışı (Kare-Kare Simülasyon)</h1>
                    <div class="flex flex-col md:flex-row gap-6">
                        ${imageUrls.map((url, index) => `
                            <div class="w-full md:w-1/3 flex flex-col items-center p-4 bg-gray-800 rounded-xl shadow-2xl border-2 border-red-700 transition-transform duration-300 hover:scale-[1.02]">
                                <h2 class="text-xl font-semibold text-gray-100 mb-3">KARE ${index + 1}</h2>
                                <div class="aspect-video w-full rounded-lg overflow-hidden shadow-xl border border-gray-700">
                                    <img src="${url}" alt="Hikaye Karesi ${index + 1}" class="w-full h-full object-cover">
                                </div>
                                <p class="mt-4 text-sm text-gray-300 italic text-center">${promptParts[index]}</p>
                            </div>
                        `).join('')}
                    </div>
                    <p class="text-center text-sm text-gray-500 mt-8">Bu dizideki görseller, video akışını simüle etmek için art arda oluşturulmuştur.</p>
                </div>
            </body>
            </html>
            \`\`\`
        `;

        const botMsg = { 
            id: Date.now() + 1, 
            role: 'ai', 
            content: `İsteğiniz üzerine, girdiğiniz 3 ayrı açıklamaya dayalı olarak bir "kare kare" görsel hikaye dizisi oluşturuldu. Önizlemeyi aşağıda açabilirsiniz.\n\n${htmlOutput}`, 
            type: 'text', 
            model: `Imagen 4.0 (Video Simülasyonu)` 
        };
        setMessages(prev => [...prev, botMsg]);

        // Kod bloğunu önizlemeye koy ve otomatik aç
        setCurrentCode(extractCode(htmlOutput));
        setShowPreview(true);


      } else if (selectedMode === 'canvas') {
        const responseContent = await runFourStepAnalysis(userMsg.content, true, imagePayload);
        
        const extractedHTML = extractCode(responseContent); 
        const primaryCode = getPrimaryCodeBlock(responseContent); 

        if (extractedHTML) {
            setCurrentCode(extractedHTML);
            setShowPreview(true); 
        } else {
            setCurrentCode(''); 
            setShowPreview(false); 
        }
        
        setPrimaryCodeInfo(primaryCode); 
        
        const botMsg = { id: Date.now() + 1, role: 'ai', content: responseContent, type: 'text', model: `${usedModelName} (4+ Aşamalı Kod)` };
        setMessages(prev => [...prev, botMsg]);
        

      } else if (selectedMode === 'derin_arastirma') {
        const responseContent = await runFourStepAnalysis(userMsg.content, false, imagePayload);
        
        const botMsg = { id: Date.now() + 1, role: 'ai', content: responseContent, type: 'text', model: `${usedModelName} (4+ Aşamalı Araştırma)` };
        setMessages(prev => [...prev, botMsg]);

      } else { // 'tek_sefer'
        setCurrentStep('InfinityAI yanıt oluşturuyor...');
        const responseContent = await callGemini(userMsg.content, 'gemini-2.5-flash-preview-09-2025', imagePayload);

        const botMsg = { id: Date.now() + 1, role: 'ai', content: responseContent, type: 'text', model: usedModelName };
        setMessages(prev => [...prev, botMsg]);
      }

    } catch (error) {
      setMessages(prev => [...prev, {
        id: Date.now() + 1,
        role: 'system',
        content: `Ciddi Hata Oluştu: ${error.message}. Servis Sağlayıcı: ElevenGalaxy`,
        type: 'error'
      }]);
    } finally {
      setIsLoading(false);
      setCurrentStep(''); 
      setError(null); // Başarılıysa hatayı temizle
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100 font-sans overflow-hidden">
      
      {/* Header */}
      <div className="flex justify-between items-center p-4 bg-gray-900 border-b border-red-700">
        <div className="flex items-center gap-3 text-red-500">
          <img src={logoUrl} alt="InfinityAI Logo" className="w-8 h-8 rounded-full shadow-lg border border-red-500" />
          <h1 className="text-xl font-bold tracking-wider">InfinityAI</h1>
        </div>
        
        {/* Code Preview Controls (Kodu Kopyala & Önizlemeyi Kapat) */}
        {!showPreview && primaryCodeInfo && (
            <div className="flex items-center gap-2">
                <button 
                    onClick={() => copyCodeToClipboard(primaryCodeInfo.code, primaryCodeInfo.language)}
                    className="flex items-center gap-2 p-2 text-gray-300 hover:text-white hover:bg-red-700 rounded-lg transition-colors border border-gray-700"
                >
                    <Copy size={20} />
                    <span>{primaryCodeInfo.language.toUpperCase()} Çekirdek Kodunu Kopyala</span>
                </button>
            </div>
        )}
      </div>
      
      {/* Copy Message Popup */}
      {copyMessage && (
          <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg shadow-xl text-white ${
              copyMessage.includes('başarıyla') ? 'bg-green-600' : 'bg-red-600'
          } transition-opacity duration-500`}>
              {copyMessage}
          </div>
      )}

      {/* Main Chat Area / Full Preview */}
      <div className="flex-1 flex flex-row relative overflow-hidden">
        
        {/* Chat Log: Tam ekran önizleme varsa gizle */}
        <div 
            className={`flex-1 flex flex-col overflow-y-auto p-6 space-y-6 transition-all duration-300 ${showPreview ? 'hidden' : 'w-full'}`} 
            ref={chatContainerRef}
        >
          {messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl p-4 shadow-xl ${
                msg.role === 'user' 
                  ? 'bg-red-700 text-white rounded-br-none' 
                  : msg.type === 'error' 
                    ? 'bg-black border border-red-500 text-red-300'
                    : 'bg-gray-900 border border-gray-800 text-gray-100 rounded-bl-none'
              }`}>
                {msg.role === 'ai' && (
                  <div className="flex items-center gap-2 mb-2 text-xs font-mono text-red-400 opacity-75">
                    <img src={logoUrl} alt="AI Logo" className="w-4 h-4 rounded-full" />
                    <span>{msg.model}</span>
                  </div>
                )}
                
                {msg.type === 'image' ? (
                  <div className="rounded-lg overflow-hidden border border-gray-700">
                    <img 
                        src={msg.content} 
                        alt="Generated AI" 
                        className="w-full h-auto max-w-md object-contain" 
                        onError={(e) => e.target.src = "https://placehold.co/512x512/7c0a0a/ffffff?text=GÖRSEL+OLUŞTURULAMADI"}
                    />
                    {/* İndirme Düğmesi */}
                    <a 
                      href={msg.content} 
                      download="infinityai_image.png" 
                      className="block text-center text-xs p-2 bg-red-600 hover:bg-red-500 text-white font-bold transition-colors"
                    >
                      <div className="flex items-center justify-center gap-2">
                        <Download size={14} />
                        Görseli İndir (.png)
                      </div>
                    </a>
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap leading-relaxed">
                    {msg.content.split('```').map((part, index) => {
                      if (index % 2 === 1) {
                        const codeContent = part.trim();
                        const firstLineEnd = codeContent.indexOf('\n');
                        const header = firstLineEnd !== -1 ? codeContent.substring(0, firstLineEnd) : '';
                        const actualCode = firstLineEnd !== -1 ? codeContent.substring(firstLineEnd + 1) : codeContent;
                        
                        let displayLang = 'Kod';
                        const langMatch = header.match(/^(\w+):/);
                        if (langMatch) {
                          displayLang = langMatch[1].toUpperCase();
                        } else {
                           const simpleLangMatch = header.match(/^(\w+)/);
                           if (simpleLangMatch) {
                               displayLang = simpleLangMatch[1].toUpperCase();
                           }
                        }

                        return (
                          <div key={index} className="bg-gray-800 p-3 rounded my-2 text-xs font-mono overflow-x-auto border border-red-800">
                            <div className="text-right text-red-400 mb-1 border-b border-gray-700 pb-1 pr-1 font-bold">{displayLang} ÇIKTISI</div>
                            <pre className="whitespace-pre-wrap text-white">{actualCode}</pre>
                          </div>
                        );
                      }
                      return <span key={index}>{part}</span>;
                    })}
                  </div>
                )}

                {/* The "Aç" button - only shows if canvas is selected OR video mode is active */}
                {msg.role === 'ai' && extractCode(msg.content) && (selectedMode === 'canvas' || selectedMode === 'video') && (
                  <button 
                    onClick={() => {
                      setCurrentCode(extractCode(msg.content));
                      setShowPreview(true);
                    }}
                    className="mt-3 flex items-center gap-2 text-xs bg-red-600 hover:bg-red-500 px-3 py-1.5 rounded transition-colors shadow-md hover:shadow-lg text-white font-bold"
                  >
                    <Play size={14} />
                    Canvas Önizleme (Aç)
                  </button>
                )}
                {/* Non-Web Code Açıklaması */}
                {msg.role === 'ai' && selectedMode === 'canvas' && getPrimaryCodeBlock(msg.content) && !extractCode(msg.content) && (
                    <p className="mt-2 text-xs text-red-300 bg-gray-800 p-2 rounded border border-red-900">
                        *Not: Üretilen kod ({getPrimaryCodeBlock(msg.content).language.toUpperCase()}) görselleştirme içermiyor veya tarayıcıda çalıştırılabilir HTML eşdeğeri üretilmedi. Kodu üst menüden kopyalayıp yerel ortamınızda çalıştırabilirsiniz.
                    </p>
                )}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-gray-900 p-4 rounded-2xl rounded-bl-none flex flex-col items-start gap-1 shadow-md border border-red-700">
                <div className="flex items-center gap-3">
                  <img src={logoUrl} alt="AI Logo" className="w-5 h-5 animate-spin" />
                  <span className="text-sm font-bold text-gray-200">InfinityAI</span>
                </div>
                {currentStep && <span className="text-xs text-red-400 mt-1">{currentStep}</span>}
              </div>
            </div>
          )}
          {/* Scroll padding for the last message */}
          <div className="h-4"></div> 
        </div>

        {/* Code Preview Panel - Tam Ekran Olacak */}
        {showPreview && (
          <div className="w-full bg-white border-l border-red-700 flex flex-col shadow-2xl animate-in slide-in-from-right duration-300">
            <div className="bg-gray-100 p-3 flex justify-start items-center border-b border-gray-300">
                {/* GERİ DÖN DÜĞMESİ */}
                <button 
                    onClick={() => setShowPreview(false)}
                    className="flex items-center gap-2 p-2 text-white hover:bg-red-700 bg-red-600 rounded-lg transition-colors font-bold shadow-md"
                >
                    <ArrowLeft size={20} />
                    <span>Sohbete Geri Dön</span>
                </button>
              <div className="flex items-center gap-2 text-gray-700 font-bold px-4">
                <Code size={18} className="text-red-600" />
                <span>Canlı Önizleme (Tarayıcı Simülasyonu)</span>
              </div>
            </div>
            <div className="flex-1 bg-white relative">
               <iframe 
                 srcDoc={currentCode} 
                 title="Preview"
                 className="w-full h-full border-none"
                 sandbox="allow-scripts allow-forms allow-modals"
               />
            </div>
          </div>
        )}
      </div>

      {/* Input Area and Mode Selector */}
      <div className="p-4 bg-gray-900 border-t border-red-700">
        
        {/* Active Image Preview (Vision) */}
        {imageUrl && (
            <div className="max-w-4xl mx-auto mb-4 p-3 bg-gray-800 border border-red-700 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <ImageIcon size={20} className="text-red-500 flex-shrink-0" />
                    <span className="text-sm text-gray-300 font-medium">Görsel Analiz İçin Hazır:</span>
                    <img src={imageUrl} alt="Preview" className="h-10 w-10 object-cover rounded border border-gray-600" />
                </div>
                <button 
                    onClick={clearImage}
                    className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                    <X size={16} />
                    Kaldır
                </button>
            </div>
        )}
        
        <div className="flex gap-3 max-w-4xl mx-auto mb-4 relative">
            
            {/* Mode Selector Button */}
            <button 
                onClick={() => setShowModeSelector(!showModeSelector)}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold transition-colors bg-red-700 text-white shadow-md border border-red-500 hover:bg-red-600"
            >
                <Zap size={18} /> 
                Mod Seç: {getModeLabel(selectedMode)}
            </button>
            
            {/* Mode Selector Dropdown/Modal */}
            {showModeSelector && (
                <div className="absolute bottom-full mb-2 w-full max-w-full bg-gray-800 border border-red-700 rounded-xl shadow-2xl z-20 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
                    {modes.map(mode => (
                        <button
                            key={mode}
                            onClick={() => handleModeSelect(mode)}
                            className={`w-full text-left p-3 flex items-center justify-between text-sm transition-colors ${
                                selectedMode === mode ? 'bg-red-700 text-white' : 'text-gray-200 hover:bg-gray-700'
                            }`}
                        >
                            {getModeLabel(mode)}
                            {selectedMode === mode && <Sparkles size={16} className="text-yellow-400" />}
                            {mode === 'video' && <Film size={16} className="text-red-300" />}
                            {mode === 'resim' && <ImageIcon size={16} className="text-red-300" />}
                            {mode === 'canvas' && <Code size={16} className="text-red-300" />}
                        </button>
                    ))}
                </div>
            )}
            
            {/* Resim/Kamera Yükleme Butonları */}
            <input 
                type="file" 
                ref={fileInputRef}
                accept="image/*" 
                onChange={handleImageUpload} 
                className="hidden" 
            />
            <button 
                onClick={() => fileInputRef.current.click()}
                title="Resim Yükle (Vision Analizi)"
                className="p-3 rounded-xl bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors"
            >
                <ImageIcon size={20} />
            </button>
             {/* Kamera Düğmesi - Aynı Girişi Tetikler */}
            <button 
                onClick={() => {
                  fileInputRef.current.setAttribute('capture', 'environment'); 
                  fileInputRef.current.click();
                  fileInputRef.current.removeAttribute('capture'); 
                }}
                title="Kameradan Çek (Dosya Seçim Modu)"
                className="p-3 rounded-xl bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors"
            >
                <Camera size={20} />
            </button>
        </div>
        
        <div className="flex gap-3 max-w-4xl mx-auto">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder={`InfinityAI'ya bir şey yaz... (Mod: ${getModeLabel(selectedMode)})`}
            className="flex-1 bg-gray-950 border border-gray-700 text-white rounded-xl px-4 py-3 focus:outline-none focus:border-red-500 transition-all placeholder:text-gray-500"
          />
          <button 
            onClick={handleSend}
            disabled={isLoading || (!input.trim() && !imageData)}
            className="bg-red-600 hover:bg-red-500 text-white p-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-red-500/30"
          >
            <Send size={24} />
          </button>
        </div>
      </div>
    </div>
  );
}

