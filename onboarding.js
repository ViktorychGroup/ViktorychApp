/* First-time setup, in the style of a new phone or a fresh Windows install:
   one focused step per screen, a big title, one line under it and a single
   primary button. Loaded only when someone signs up (accounts.js injects
   it), so the first load of the app does not pay for it.

   Before the account exists it shows the welcome, the language and how to
   start; accounts.js then runs its own account steps inside the same shell
   (onb.shell); after the account exists it continues with the picture,
   theme, data usage, notifications, install and a few accounts to follow,
   then the finale. Progress lives in localStorage so a reload resumes the
   same step. Strings for this module live here in en, es, hi and ru.

   Motion: steps move on a shared axis (forward slides left, back slides
   right) through the View Transitions API where the browser has it and a
   CSS slide where it does not. Only transform and opacity animate. With
   reduced motion every change is a short crossfade. */
(function () {
  "use strict";
  var KEY = "viktorychapp-onboard-v1";
  var LANGS = ["en", "es", "hi", "ru"];
  var NATIVE = { en: "English", es: "Español", hi: "हिन्दी", ru: "Русский" };
  var HELLO = ["Hello", "Hola", "Привет", "नमस्ते", "Bonjour", "Hallo", "Ciao", "Olá", "こんにちは", "안녕하세요"];
  var PRE = ["welcome", "language", "choose"];
  var POST = ["profile", "privacy", "theme", "look", "content", "data", "notify", "alerts", "install", "follow", "done"];
  /* Every screen in order with the rail group it belongs to. accounts.js
     owns name, handle, passkey and secure; temp is the temporary account. */
  var FLOW = [
    ["welcome", "basics"], ["language", "basics"], ["choose", "basics"],
    ["name", "account"], ["handle", "account"], ["temp", "account"],
    ["passkey", "security"], ["secure", "security"],
    ["profile", "personal"], ["privacy", "personal"], ["theme", "personal"], ["look", "personal"], ["content", "personal"], ["data", "personal"], ["notify", "personal"], ["alerts", "personal"], ["install", "personal"], ["follow", "personal"],
    ["done", "ready"]
  ];
  var GROUPS = [["basics", "gBasics"], ["account", "gAccount"], ["security", "gSecurity"], ["personal", "gPersonal"], ["ready", "gReady"]];
  /* The dots count the steps between the welcome and the finale. */
  var DOTS = ["language", "choose", "name", "handle", "passkey", "secure", "profile", "privacy", "theme", "look", "content", "data", "notify", "alerts", "install", "follow"];
  var STR = {
    en: {
      welcome: "Welcome to {app}",
      welcomeSub: "Let's get you set up. It takes about a minute.",
      start: "Get started",
      quick: "Quick sign-up",
      quickHint: "Prefer one simple form?",
      signIn: "Sign in",
      haveAccount: "Already have an account?",
      tryTemp: "Try a temporary account",
      langTitle: "Choose your language",
      langSub: "You can change it any time in Settings.",
      suggested: "Suggested for this device",
      region: "Region",
      regionNote: "Dates and times follow this device.",
      chooseTitle: "How do you want to start?",
      chooseSub: "Pick one. You can switch later.",
      createT: "Create an account",
      createS: "Takes about a minute.",
      loginT: "Sign in",
      loginS: "Use your account number or a passkey.",
      tempS: "No sign-up. It deletes itself at the time you pick.",
      nameTitle: "What's your name?",
      nameSub: "This is how you appear on your profile.",
      handleTitle: "Pick a username",
      passkeyTitle: "Protect your account",
      passkeySub: "A passkey signs you in with this device's fingerprint, face or screen lock.",
      secureTitle: "Save your account number",
      tempTitle: "Temporary account",
      next: "Continue",
      back: "Back",
      skip: "Skip",
      close: "Close",
      notNow: "Not now",
      step: "Step {n} of {total}",
      stepSay: "Step {n} of {total}: {title}",
      gBasics: "Basics",
      gAccount: "Account",
      gSecurity: "Security",
      gPersonal: "Personalize",
      gReady: "All set",
      photoTitle: "Pick a profile picture",
      photoSub: "Have a favorite selfie? Add it now, or do it later.",
      photoAdd: "Upload a photo",
      photoChange: "Change photo",
      photoFail: "Could not use that photo. Try another one.",
      name: "Name",
      shape: "Picture shape",
      round: "Round",
      square: "Square",
      saving: "Saving…",
      saveLater: "Saved on this device. It will upload when you are back online.",
      themeTitle: "Choose a look",
      themeSub: "See it live. Change it any time in Settings.",
      theme: "Theme",
      previewName: "Preview",
      previewText: "This is how posts look with this theme.",
      themeDefault: "Default",
      themeDim: "Dim",
      themeDark: "Lights out",
      dataTitle: "Data usage",
      dataSub: "Choose how much mobile data the app uses.",
      dataStd: "Standard",
      dataStdSub: "Full-quality pictures. Videos can autoplay.",
      saver: "Save data",
      saverSub: "Uses as little mobile data as possible: smaller pictures, no autoplay.",
      notifyTitle: "Turn on notifications?",
      notifySub: "Get alerts for replies, new posts and warnings such as nearly full storage. Your browser asks next.",
      notifyOn: "Turn on notifications",
      notifyDone: "Notifications are on.",
      notifyNo: "This browser can't show notifications. You can try again in Settings.",
      notifyBlocked: "Notifications are blocked for this site. Allow them in the browser's site settings.",
      installTitle: "Install {app}",
      installSub: "It opens full screen, loads faster and keeps posts you opened for offline use.",
      install: "Install",
      installIos1: "Tap Share in Safari",
      installIos2: "Choose Add to Home Screen",
      installIos3: "Tap Add",
      installIosBrowser: "Open this page in Safari to add it to your Home Screen.",
      installHint: "Use the install icon in the address bar or the browser menu.",
      followTitle: "Follow a few accounts",
      followSub: "They fill your timeline. You can follow more any time.",
      follow: "Follow",
      following: "Following",
      finding: "Finding accounts…",
      none: "Nothing to suggest yet. Explore has more later.",
      doneTitle: "You're all set!",
      skipAll: "Skip all and finish",
      privacyTitle: "Your privacy",
      privacySub: "Choose who sees what.",
      protect: "Protect your posts",
      privateLists: "Keep follow lists private",
      discover: "Suggest me to others",
      online: "Show when I'm online",
      friendsSwitch: "Friends and friend requests",
      friendsSwitchSub: "Friend requests, friends lists and friends’ online status. You can change this later in Settings.",
      saveFail: "Couldn't save. Try again.",
      lookTitle: "Make it yours",
      lookSub: "Pick a color and text size.",
      accent: "Color",
      textSize: "Text size",
      cBlue: "Blue",
      cYellow: "Yellow",
      cPink: "Pink",
      cPurple: "Purple",
      cOrange: "Orange",
      cGreen: "Green",
      contentTitle: "What you see",
      contentSub: "Translation and video playback.",
      translate: "Live Translate",
      autoplay: "Autoplay videos",
      apAll: "Always",
      apWifi: "Wi-Fi only",
      apNever: "Never",
      alertsTitle: "Alerts",
      alertsSub: "Choose how alerts reach you.",
      vibrate: "Vibration",
      notifNames: "Show names in alerts",
      notifPreview: "Show message previews",
      doneSub: "You can change these anytime in Settings.",
      doneBtn: "Go to your timeline",
      setup: "Set up your account"
    },
    es: {
      welcome: "Te damos la bienvenida a {app}",
      welcomeSub: "Vamos a prepararlo todo. Tarda alrededor de un minuto.",
      start: "Empezar",
      quick: "Registro rápido",
      quickHint: "¿Prefieres un solo formulario?",
      signIn: "Iniciar sesión",
      haveAccount: "¿Ya tienes una cuenta?",
      tryTemp: "Probar una cuenta temporal",
      langTitle: "Elige tu idioma",
      langSub: "Puedes cambiarlo cuando quieras en Configuración.",
      suggested: "Sugerido para este dispositivo",
      region: "Región",
      regionNote: "Las fechas y horas siguen a este dispositivo.",
      chooseTitle: "¿Cómo quieres empezar?",
      chooseSub: "Elige una opción. Puedes cambiar después.",
      createT: "Crear una cuenta",
      createS: "Tarda alrededor de un minuto.",
      loginT: "Iniciar sesión",
      loginS: "Usa tu número de cuenta o una llave de acceso.",
      tempS: "Sin registro. Se borra sola a la hora que elijas.",
      nameTitle: "¿Cómo te llamas?",
      nameSub: "Así apareces en tu perfil.",
      handleTitle: "Elige un nombre de usuario",
      passkeyTitle: "Protege tu cuenta",
      passkeySub: "Una llave de acceso inicia sesión con la huella, la cara o el bloqueo de pantalla de este dispositivo.",
      secureTitle: "Guarda tu número de cuenta",
      tempTitle: "Cuenta temporal",
      next: "Continuar",
      back: "Atrás",
      skip: "Omitir",
      close: "Cerrar",
      notNow: "Ahora no",
      step: "Paso {n} de {total}",
      stepSay: "Paso {n} de {total}: {title}",
      gBasics: "Lo básico",
      gAccount: "Cuenta",
      gSecurity: "Seguridad",
      gPersonal: "Personalizar",
      gReady: "Todo listo",
      photoTitle: "Elige una foto de perfil",
      photoSub: "¿Tienes un selfi favorito? Súbelo ahora o más tarde.",
      photoAdd: "Subir una foto",
      photoChange: "Cambiar foto",
      photoFail: "No se pudo usar esa foto. Prueba con otra.",
      name: "Nombre",
      shape: "Forma de la foto",
      round: "Redonda",
      square: "Cuadrada",
      saving: "Guardando…",
      saveLater: "Guardado en este dispositivo. Se subirá cuando vuelvas a tener conexión.",
      themeTitle: "Elige un aspecto",
      themeSub: "Míralo en directo. Cámbialo cuando quieras en Configuración.",
      theme: "Tema",
      previewName: "Vista previa",
      previewText: "Así se ven las publicaciones con este tema.",
      themeDefault: "Predeterminado",
      themeDim: "Atenuado",
      themeDark: "Sin luz",
      dataTitle: "Uso de datos",
      dataSub: "Elige cuántos datos móviles usa la app.",
      dataStd: "Estándar",
      dataStdSub: "Imágenes con calidad completa. Los videos pueden reproducirse solos.",
      saver: "Ahorrar datos",
      saverSub: "Usa los menos datos móviles posibles: imágenes más pequeñas y sin reproducción automática.",
      notifyTitle: "¿Activar las notificaciones?",
      notifySub: "Recibe avisos de respuestas, publicaciones nuevas y advertencias como el almacenamiento casi lleno. Después te preguntará el navegador.",
      notifyOn: "Activar notificaciones",
      notifyDone: "Las notificaciones están activadas.",
      notifyNo: "Este navegador no puede mostrar notificaciones. Puedes volver a intentarlo en Configuración.",
      notifyBlocked: "Las notificaciones están bloqueadas para este sitio. Permítelas en la configuración del sitio del navegador.",
      installTitle: "Instala {app}",
      installSub: "Se abre a pantalla completa, carga más rápido y guarda las publicaciones que abriste para verlas sin conexión.",
      install: "Instalar",
      installIos1: "Toca Compartir en Safari",
      installIos2: "Elige Añadir a pantalla de inicio",
      installIos3: "Toca Añadir",
      installIosBrowser: "Abre esta página en Safari para añadirla a tu pantalla de inicio.",
      installHint: "Usa el icono de instalar de la barra de direcciones o el menú del navegador.",
      followTitle: "Sigue algunas cuentas",
      followSub: "Llenan tu cronología. Puedes seguir más cuando quieras.",
      follow: "Seguir",
      following: "Siguiendo",
      finding: "Buscando cuentas…",
      none: "Aún no hay sugerencias. Explorar tendrá más después.",
      doneTitle: "¡Todo listo!",
      skipAll: "Omitir todo y terminar",
      privacyTitle: "Tu privacidad",
      privacySub: "Elige quién ve qué.",
      protect: "Protege tus publicaciones",
      privateLists: "Listas de seguidos privadas",
      discover: "Sugerirme a otras personas",
      online: "Mostrar cuándo estoy en línea",
      friendsSwitch: "Amigos y solicitudes de amistad",
      friendsSwitchSub: "Solicitudes de amistad, listas de amigos y el estado en línea de tus amigos. Puedes cambiarlo más tarde en Configuración.",
      saveFail: "No se pudo guardar. Inténtalo de nuevo.",
      lookTitle: "Hazlo tuyo",
      lookSub: "Elige un color y el tamaño del texto.",
      accent: "Color",
      textSize: "Tamaño del texto",
      cBlue: "Azul",
      cYellow: "Amarillo",
      cPink: "Rosa",
      cPurple: "Morado",
      cOrange: "Naranja",
      cGreen: "Verde",
      contentTitle: "Lo que ves",
      contentSub: "Traducción y reproducción de vídeos.",
      translate: "Traducción en vivo",
      autoplay: "Reproducir vídeos automáticamente",
      apAll: "Siempre",
      apWifi: "Solo Wi-Fi",
      apNever: "Nunca",
      alertsTitle: "Alertas",
      alertsSub: "Elige cómo te llegan las alertas.",
      vibrate: "Vibración",
      notifNames: "Mostrar nombres en las alertas",
      notifPreview: "Mostrar vista previa de mensajes",
      doneSub: "Puedes cambiar esto cuando quieras en Configuración.",
      doneBtn: "Ir a tu cronología",
      setup: "Configura tu cuenta"
    },
    hi: {
      welcome: "{app} में आपका स्वागत है",
      welcomeSub: "चलिए सब कुछ तैयार करते हैं। इसमें लगभग एक मिनट लगेगा।",
      start: "शुरू करें",
      quick: "झटपट साइन-अप",
      quickHint: "एक ही सादा फ़ॉर्म चाहिए?",
      signIn: "साइन इन करें",
      haveAccount: "पहले से खाता है?",
      tryTemp: "अस्थायी खाता आज़माएँ",
      langTitle: "अपनी भाषा चुनें",
      langSub: "आप इसे कभी भी सेटिंग्स में बदल सकते हैं।",
      suggested: "इस डिवाइस के लिए सुझाई गई",
      region: "क्षेत्र",
      regionNote: "तारीख़ और समय इस डिवाइस के अनुसार चलते हैं।",
      chooseTitle: "आप कैसे शुरू करना चाहेंगे?",
      chooseSub: "एक चुनें। बाद में बदल सकते हैं।",
      createT: "खाता बनाएँ",
      createS: "इसमें लगभग एक मिनट लगता है।",
      loginT: "साइन इन करें",
      loginS: "अपना खाता नंबर या पासकी इस्तेमाल करें।",
      tempS: "साइन-अप नहीं। यह आपके चुने समय पर अपने आप मिट जाता है।",
      nameTitle: "आपका नाम क्या है?",
      nameSub: "आपकी प्रोफ़ाइल पर यही दिखेगा।",
      handleTitle: "यूज़रनेम चुनें",
      passkeyTitle: "अपने खाते को सुरक्षित करें",
      passkeySub: "पासकी इस डिवाइस के फ़िंगरप्रिंट, चेहरे या स्क्रीन लॉक से साइन इन करती है।",
      secureTitle: "अपना खाता नंबर सहेजें",
      tempTitle: "अस्थायी खाता",
      next: "जारी रखें",
      back: "वापस",
      skip: "छोड़ें",
      close: "बंद करें",
      notNow: "अभी नहीं",
      step: "चरण {n} / {total}",
      stepSay: "चरण {n} / {total}: {title}",
      gBasics: "शुरुआत",
      gAccount: "खाता",
      gSecurity: "सुरक्षा",
      gPersonal: "अपने हिसाब से",
      gReady: "सब तैयार",
      photoTitle: "प्रोफ़ाइल फ़ोटो चुनें",
      photoSub: "कोई पसंदीदा सेल्फ़ी है? अभी जोड़ें, या बाद में।",
      photoAdd: "फ़ोटो अपलोड करें",
      photoChange: "फ़ोटो बदलें",
      photoFail: "यह फ़ोटो इस्तेमाल नहीं हो सकी। कोई दूसरी आज़माएँ।",
      name: "नाम",
      shape: "फ़ोटो का आकार",
      round: "गोल",
      square: "चौकोर",
      saving: "सहेजा जा रहा है…",
      saveLater: "इस डिवाइस पर सहेजा गया। इंटरनेट वापस आने पर अपलोड होगा।",
      themeTitle: "रूप चुनें",
      themeSub: "तुरंत देखें। सेटिंग्स में कभी भी बदलें।",
      theme: "थीम",
      previewName: "झलक",
      previewText: "इस थीम में पोस्ट ऐसी दिखती हैं।",
      themeDefault: "डिफ़ॉल्ट",
      themeDim: "मंद",
      themeDark: "पूरा अँधेरा",
      dataTitle: "डेटा उपयोग",
      dataSub: "चुनें कि ऐप कितना मोबाइल डेटा इस्तेमाल करे।",
      dataStd: "सामान्य",
      dataStdSub: "पूरी क्वालिटी की तस्वीरें। वीडियो अपने आप चल सकते हैं।",
      saver: "डेटा बचाएँ",
      saverSub: "जितना हो सके कम मोबाइल डेटा: छोटी तस्वीरें, कोई ऑटोप्ले नहीं।",
      notifyTitle: "सूचनाएँ चालू करें?",
      notifySub: "जवाबों, नई पोस्ट और लगभग भरे स्टोरेज जैसी चेतावनियों की सूचना पाएँ। इसके बाद ब्राउज़र पूछेगा।",
      notifyOn: "सूचनाएँ चालू करें",
      notifyDone: "सूचनाएँ चालू हैं।",
      notifyNo: "यह ब्राउज़र सूचनाएँ नहीं दिखा सकता। सेटिंग्स में फिर से कोशिश करें।",
      notifyBlocked: "इस साइट के लिए सूचनाएँ बंद हैं। ब्राउज़र की साइट सेटिंग्स में इन्हें अनुमति दें।",
      installTitle: "{app} इंस्टॉल करें",
      installSub: "यह पूरी स्क्रीन पर खुलता है, तेज़ी से लोड होता है और खोली गई पोस्ट ऑफ़लाइन रखता है।",
      install: "इंस्टॉल करें",
      installIos1: "Safari में शेयर पर टैप करें",
      installIos2: "होम स्क्रीन पर जोड़ें चुनें",
      installIos3: "जोड़ें पर टैप करें",
      installIosBrowser: "होम स्क्रीन पर जोड़ने के लिए यह पेज Safari में खोलें।",
      installHint: "एड्रेस बार में इंस्टॉल आइकन या ब्राउज़र मेनू इस्तेमाल करें।",
      followTitle: "कुछ खातों को फ़ॉलो करें",
      followSub: "इनसे आपकी टाइमलाइन भरती है। आप कभी भी और फ़ॉलो कर सकते हैं।",
      follow: "फ़ॉलो करें",
      following: "फ़ॉलो कर रहे हैं",
      finding: "खाते ढूँढे जा रहे हैं…",
      none: "अभी कोई सुझाव नहीं। एक्सप्लोर में बाद में और मिलेंगे।",
      doneTitle: "सब तैयार है!",
      skipAll: "सब छोड़ें और पूरा करें",
      privacyTitle: "आपकी निजता",
      privacySub: "चुनें कि कौन क्या देखे।",
      protect: "अपनी पोस्ट सुरक्षित करें",
      privateLists: "फ़ॉलो सूचियाँ निजी रखें",
      discover: "दूसरों को मेरा सुझाव दें",
      online: "दिखाएँ कि मैं कब ऑनलाइन हूँ",
      friendsSwitch: "दोस्त और फ़्रेंड रिक्वेस्ट",
      friendsSwitchSub: "फ़्रेंड रिक्वेस्ट, दोस्तों की सूची और दोस्तों का ऑनलाइन स्टेटस। आप इसे बाद में सेटिंग्स में बदल सकते हैं।",
      saveFail: "सहेजा नहीं जा सका। फिर से कोशिश करें।",
      lookTitle: "इसे अपना बनाएँ",
      lookSub: "रंग और टेक्स्ट का आकार चुनें।",
      accent: "रंग",
      textSize: "टेक्स्ट का आकार",
      cBlue: "नीला",
      cYellow: "पीला",
      cPink: "गुलाबी",
      cPurple: "बैंगनी",
      cOrange: "नारंगी",
      cGreen: "हरा",
      contentTitle: "आप क्या देखते हैं",
      contentSub: "अनुवाद और वीडियो प्लेबैक।",
      translate: "लाइव अनुवाद",
      autoplay: "वीडियो अपने-आप चलाएँ",
      apAll: "हमेशा",
      apWifi: "सिर्फ़ वाई-फ़ाई",
      apNever: "कभी नहीं",
      alertsTitle: "अलर्ट",
      alertsSub: "चुनें कि अलर्ट आप तक कैसे पहुँचें।",
      vibrate: "कंपन",
      notifNames: "अलर्ट में नाम दिखाएँ",
      notifPreview: "संदेश का पूर्वावलोकन दिखाएँ",
      doneSub: "आप इन्हें कभी भी सेटिंग्स में बदल सकते हैं।",
      doneBtn: "अपनी टाइमलाइन पर जाएँ",
      setup: "अपना खाता सेट करें"
    },
    ru: {
      welcome: "Добро пожаловать в {app}",
      welcomeSub: "Давайте всё настроим. Это займёт около минуты.",
      start: "Начать",
      quick: "Быстрая регистрация",
      quickHint: "Хотите одну простую форму?",
      signIn: "Войти",
      haveAccount: "Уже есть аккаунт?",
      tryTemp: "Попробовать временный аккаунт",
      langTitle: "Выберите язык",
      langSub: "Его можно сменить в любой момент в настройках.",
      suggested: "Подходит для этого устройства",
      region: "Регион",
      regionNote: "Даты и время берутся с этого устройства.",
      chooseTitle: "С чего начнём?",
      chooseSub: "Выберите вариант. Потом можно передумать.",
      createT: "Создать аккаунт",
      createS: "Займёт около минуты.",
      loginT: "Войти",
      loginS: "По номеру аккаунта или ключу доступа.",
      tempS: "Без регистрации. Удалится сам в выбранное время.",
      nameTitle: "Как вас зовут?",
      nameSub: "Так вас увидят в профиле.",
      handleTitle: "Выберите имя пользователя",
      passkeyTitle: "Защитите аккаунт",
      passkeySub: "Ключ доступа позволяет входить по отпечатку пальца, лицу или блокировке экрана этого устройства.",
      secureTitle: "Сохраните номер аккаунта",
      tempTitle: "Временный аккаунт",
      next: "Продолжить",
      back: "Назад",
      skip: "Пропустить",
      close: "Закрыть",
      notNow: "Не сейчас",
      step: "Шаг {n} из {total}",
      stepSay: "Шаг {n} из {total}: {title}",
      gBasics: "Основное",
      gAccount: "Аккаунт",
      gSecurity: "Безопасность",
      gPersonal: "Под себя",
      gReady: "Готово",
      photoTitle: "Выберите фото профиля",
      photoSub: "Есть любимое селфи? Добавьте сейчас или позже.",
      photoAdd: "Загрузить фото",
      photoChange: "Сменить фото",
      photoFail: "Не удалось использовать это фото. Попробуйте другое.",
      name: "Имя",
      shape: "Форма фото",
      round: "Круглая",
      square: "Квадратная",
      saving: "Сохранение…",
      saveLater: "Сохранено на этом устройстве. Загрузится, когда появится связь.",
      themeTitle: "Выберите оформление",
      themeSub: "Смотрите сразу. Поменять можно в настройках.",
      theme: "Тема",
      previewName: "Предпросмотр",
      previewText: "Так выглядят посты с этой темой.",
      themeDefault: "Светлая",
      themeDim: "Сумерки",
      themeDark: "Ночь",
      dataTitle: "Трафик",
      dataSub: "Выберите, сколько мобильного трафика тратит приложение.",
      dataStd: "Обычный",
      dataStdSub: "Картинки в полном качестве. Видео могут запускаться сами.",
      saver: "Экономия трафика",
      saverSub: "Как можно меньше мобильного трафика: картинки меньше, без автовоспроизведения.",
      notifyTitle: "Включить уведомления?",
      notifySub: "Узнавайте об ответах, новых постах и предупреждениях, например о почти заполненном хранилище. Дальше спросит браузер.",
      notifyOn: "Включить уведомления",
      notifyDone: "Уведомления включены.",
      notifyNo: "Этот браузер не умеет показывать уведомления. Попробуйте позже в настройках.",
      notifyBlocked: "Уведомления для этого сайта заблокированы. Разрешите их в настройках сайта в браузере.",
      installTitle: "Установите {app}",
      installSub: "Открывается на весь экран, грузится быстрее и хранит открытые посты офлайн.",
      install: "Установить",
      installIos1: "Нажмите «Поделиться» в Safari",
      installIos2: "Выберите «На экран Домой»",
      installIos3: "Нажмите «Добавить»",
      installIosBrowser: "Откройте эту страницу в Safari, чтобы добавить её на экран Домой.",
      installHint: "Нажмите значок установки в адресной строке или откройте меню браузера.",
      followTitle: "Подпишитесь на несколько аккаунтов",
      followSub: "Они наполнят вашу ленту. Подписаться на других можно в любой момент.",
      follow: "Читать",
      following: "Читаю",
      finding: "Ищем аккаунты…",
      none: "Пока нечего предложить. Больше будет в разделе «Обзор».",
      doneTitle: "Всё готово!",
      skipAll: "Пропустить всё и завершить",
      privacyTitle: "Конфиденциальность",
      privacySub: "Выберите, кто что видит.",
      protect: "Защитить посты",
      privateLists: "Скрыть списки подписок",
      discover: "Предлагать меня другим",
      online: "Показывать, когда я в сети",
      friendsSwitch: "Друзья и запросы в друзья",
      friendsSwitchSub: "Запросы в друзья, списки друзей и статус друзей в сети. Это можно изменить позже в настройках.",
      saveFail: "Не удалось сохранить. Попробуйте ещё раз.",
      lookTitle: "Под себя",
      lookSub: "Выберите цвет и размер текста.",
      accent: "Цвет",
      textSize: "Размер текста",
      cBlue: "Синий",
      cYellow: "Жёлтый",
      cPink: "Розовый",
      cPurple: "Фиолетовый",
      cOrange: "Оранжевый",
      cGreen: "Зелёный",
      contentTitle: "Что вы видите",
      contentSub: "Перевод и воспроизведение видео.",
      translate: "Живой перевод",
      autoplay: "Автовоспроизведение видео",
      apAll: "Всегда",
      apWifi: "Только Wi-Fi",
      apNever: "Никогда",
      alertsTitle: "Оповещения",
      alertsSub: "Выберите, как приходят оповещения.",
      vibrate: "Вибрация",
      notifNames: "Показывать имена",
      notifPreview: "Показывать текст сообщений",
      doneSub: "Это можно изменить в настройках в любое время.",
      doneBtn: "Перейти в ленту",
      setup: "Настройте аккаунт"
    }
  };
  var state = { saver: null, stage: "", step: 0, lang: "", open: false, dir: 1, photo: "", photoError: "", name: "", nameTouched: false, busy: false, note: "", notify: "", installNote: "", follows: {}, prefs: {}, waitTimer: 0, pendingProfile: null, painted: "", leaving: false };
  var root = null;
  var lastIndex = { dot: -1, group: -1, step: "" };

  function readDoc() {
    try {
      var doc = JSON.parse(localStorage.getItem(KEY) || "null");
      return doc && typeof doc === "object" ? doc : null;
    } catch (err) { return null; }
  }
  function writeDoc(doc) {
    try {
      if (doc) localStorage.setItem(KEY, JSON.stringify(doc));
      else localStorage.removeItem(KEY);
    } catch (err) { /* private mode: the flow still runs for this page */ }
  }
  function save() {
    var doc = readDoc() || {};
    doc.stage = state.stage;
    doc.step = state.step;
    doc.name = stepName();
    doc.lang = state.lang;
    doc.at = Date.now();
    writeDoc(doc);
  }
  function validLang(code) {
    code = String(code || "").toLowerCase().split("-")[0];
    return LANGS.indexOf(code) >= 0 ? code : "";
  }
  function detectLang() {
    var list = [];
    try { list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]; } catch (err) { list = []; }
    for (var i = 0; i < list.length; i++) {
      var code = validLang(list[i]);
      if (code) return code;
    }
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      if (/^Asia\/(Kolkata|Calcutta)$/.test(tz)) return "hi";
    } catch (err) { /* no time zone */ }
    var current = window.SI18n && window.SI18n.getLang ? validLang(window.SI18n.getLang()) : "";
    return current || "en";
  }
  function regionName() {
    try {
      var loc = (navigator.languages && navigator.languages[0]) || navigator.language || "";
      var parts = String(loc).split("-");
      var region = parts.length > 1 ? parts[parts.length - 1].toUpperCase() : "";
      if (region && /^[A-Z]{2}$/.test(region) && typeof Intl.DisplayNames === "function") {
        return new Intl.DisplayNames([lang()], { type: "region" }).of(region) || "";
      }
    } catch (err) { /* no region names */ }
    return "";
  }
  function lang() {
    // The language the page shows wins, so a title never stays in the
    // browser's language while the rest of the screen is translated.
    return validLang(window.SI18n && window.SI18n.getLang && window.SI18n.getLang()) || validLang(state.lang) || "en";
  }
  function t(key, vars) {
    var pack = STR[lang()] || STR.en;
    var text = pack[key] != null ? pack[key] : (STR.en[key] != null ? STR.en[key] : key);
    if (vars) text = text.replace(/\{(\w+)\}/g, function (m, name) { return vars[name] != null ? String(vars[name]) : m; });
    return text;
  }
  function appName() {
    return (window.SI18n && window.SI18n.productName && window.SI18n.productName("app")) || "ViktorychApp";
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (err) { return false; }
  }
  function finePointer() {
    try { return !!(window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches); } catch (err) { return false; }
  }
  function accounts() { return window.ViktorychAccounts || null; }
  function setup() { return window.ViktorychSetup || null; }
  function mark(cls) {
    var marks = window.ViktorychMarks || {};
    var icon = marks.mark || { box: "0 0 24 24", body: "" };
    return '<svg class="' + (cls || "oobe-mark") + '" viewBox="' + icon.box + '" fill="currentColor" aria-hidden="true">' + icon.body + "</svg>";
  }

  /* Outline icons on a 24px grid with the nav icons' stroke. A selected
     option fills its icon. */
  var ICONS = {
    back: '<path d="M20 12H5M11 5l-7 7 7 7"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c0-3.6 3.6-6.5 8-6.5s8 2.9 8 6.5z"/>',
    at: '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>',
    key: '<circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8 20 3M16.5 6.5l3 3M14.5 8.5l2 2"/>',
    shield: '<path d="M12 2.8 4.5 5.8v5.7c0 4.6 3.2 8.5 7.5 9.7 4.3-1.2 7.5-5.1 7.5-9.7V5.8z"/><path d="m8.6 12.1 2.4 2.4 4.4-4.8"/>',
    camera: '<path d="M3.5 8.5h3.6l2-2.8h5.8l2 2.8h3.6v11h-17z"/><circle cx="12" cy="13.6" r="3.6"/>',
    theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
    data: '<path d="M4.5 20v-3.5M9.5 20v-7M14.5 20V9.5M19.5 20V5"/>',
    bell: '<path d="M5.5 17h13l-1.4-2.2V10.5a5.1 5.1 0 0 0-10.2 0v4.3z"/><path d="M10 20.2h4"/>',
    phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.6"/><path d="M12 7v6.5M9.2 10.8 12 13.6l2.8-2.8M10.4 18.3h3.2"/>',
    people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.3 2.9-5.6 6.5-5.6s6.5 2.3 6.5 5.6z"/><path d="M15.6 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2.2.7 3.5 2.6 3.5 5.2"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    signin: '<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14M10 8l4 4-4 4M14 12H3.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
    bolt: '<path d="M13.2 2.5 5 13.5h6l-1.2 8 8.2-11h-6z"/>',
    chev: '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    leaf: '<path d="M5 19c0-8 5-13.5 15-14-.4 9.5-5.6 15-13 15M5 19l7-7"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.4"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7M12 14.6v2.4"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.3 0 1.9-.8 1.9-1.7 0-1.3-1-1.5-1-2.6 0-.9.7-1.6 1.6-1.6h2.2A4.3 4.3 0 0 0 21 10.8C21 6.4 17 3 12 3z"/><circle cx="7.6" cy="11.5" r="1.1"/><circle cx="10.4" cy="7.4" r="1.1"/><circle cx="15.2" cy="7.6" r="1.1"/>',
    play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9.2 5 2.8-5 2.8z"/>',
    vibrate: '<rect x="8" y="3.5" width="8" height="17" rx="2"/><path d="M4.5 8v8M2 10v4M19.5 8v8M22 10v4"/>'
  };
  function icon(name, cls) {
    return '<svg class="' + (cls || "oobe-ico") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (ICONS[name] || "") + "</svg>";
  }

  function flowIndex(id) {
    for (var i = 0; i < FLOW.length; i++) if (FLOW[i][0] === id) return i;
    return 0;
  }
  function groupIndex(id) {
    var g = FLOW[flowIndex(id)][1];
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i][0] === g) return i;
    return 0;
  }
  function dotIndex(id) {
    if (id === "temp") return DOTS.indexOf("name");
    if (id === "done") return DOTS.length;
    return DOTS.indexOf(id);
  }

  /* A step's place for the dots, the rail and the screen reader. */
  function placeOf(id) {
    var n = dotIndex(id);
    return { n: n, total: DOTS.length, label: n >= 0 && n < DOTS.length ? t("step", { n: n + 1, total: DOTS.length }) : "" };
  }
  function dotsHtml(id, prev) {
    var n = dotIndex(id);
    if (n < 0 || n >= DOTS.length) return '<span class="oobe-dots is-empty" aria-hidden="true"></span>';
    var from = prev >= 0 && prev < DOTS.length ? prev : n;
    var dots = "";
    for (var i = 0; i < DOTS.length; i++) dots += '<i class="' + (i < n ? "done" : i === n ? "now" : "") + '"></i>';
    return '<span class="oobe-dots" role="progressbar" aria-valuemin="1" aria-valuemax="' + DOTS.length + '" aria-valuenow="' + (n + 1) + '" aria-label="' + esc(t("step", { n: n + 1, total: DOTS.length })) + '" style="--oobe-n:' + n + ";--oobe-from:" + from + '">' + dots + '<b class="oobe-dot-ind" aria-hidden="true"></b></span>';
  }
  function railHtml(id, prevGroup) {
    var g = groupIndex(id);
    var from = prevGroup >= 0 ? prevGroup : g;
    var items = GROUPS.map(function (grp, i) {
      var cls = i < g ? "done" : i === g ? "now" : "";
      return '<li class="' + cls + '"' + (i === g ? ' aria-current="step"' : "") + '><span class="oobe-rail-dot">' + (i < g ? icon("check", "oobe-rail-tick") : "") + "</span><span>" + esc(t(grp[1])) + "</span></li>";
    }).join("");
    return '<ol class="oobe-rail" style="--oobe-g:' + g + ";--oobe-gfrom:" + from + '">' + items + '<b class="oobe-rail-ind" aria-hidden="true"></b></ol>';
  }
  /* The shared frame. accounts.js passes its own class names so its
     handlers keep working, and its own buttons for Back and Skip. */
  function shell(o) {
    o = o || {};
    var id = o.step || "welcome";
    var moved = lastIndex.step !== id;
    var prevDot = moved ? lastIndex.dot : dotIndex(id);
    var prevGroup = moved ? lastIndex.group : groupIndex(id);
    var dir = o.dir != null ? o.dir : (lastIndex.step ? (flowIndex(id) >= flowIndex(lastIndex.step) ? 1 : -1) : 1);
    if (moved) {
      lastIndex.step = id;
      lastIndex.dot = dotIndex(id);
      lastIndex.group = groupIndex(id);
    }
    var vt = document.documentElement.hasAttribute("data-oobe-vt");
    var enter = moved && o.anim !== false ? " oobe-enter" + (vt ? "" : (dir < 0 ? " oobe-from-back" : " oobe-from-fwd")) : "";
    var place = placeOf(id);
    var head = '<header class="oobe-head">' + (o.left || "<span></span>") + dotsHtml(id, prevDot) + (o.right || "<span></span>") + "</header>";
    var side = '<aside class="oobe-side"><div class="oobe-brand">' + mark("oobe-mark") + "</div>" + railHtml(id, prevGroup) + (place.label ? '<p class="oobe-count">' + esc(place.label) + "</p>" : '<p class="oobe-count"></p>') + "</aside>";
    var step = '<div class="oobe-step' + enter + (o.center ? " is-center" : "") + '">' +
      '<div class="oobe-scroll"><div class="oobe-main">' +
      (o.top || "") +
      (o.icon ? '<span class="oobe-step-ico">' + icon(o.icon) + "</span>" : "") +
      '<h1 class="oobe-title" id="oobe-title" tabindex="-1">' + esc(o.title || "") + "</h1>" +
      (o.sub ? '<p class="oobe-sub">' + esc(o.sub) + "</p>" : "") +
      (o.body || "") + "</div></div>" +
      (o.foot ? '<div class="oobe-foot">' + o.foot + "</div>" : "") +
      "</div>";
    return '<div class="oobe ' + (o.cls || "") + '" data-step="' + esc(id) + '"><div class="oobe-card ' + (o.cardCls || "") + '" role="dialog" aria-modal="true" aria-labelledby="oobe-title"' + (place.label ? ' aria-describedby="oobe-count"' : "") + ">" + side + '<section class="oobe-pane">' + head + step + "</section>" + (place.label ? '<span class="oobe-sr" id="oobe-count">' + esc(place.label) + "</span>" : "") + "</div></div>";
  }
  /* One polite live region for the whole flow, so each new step is read. */
  function announce(text) {
    var live = document.getElementById("oobe-live");
    if (!live) {
      live = document.createElement("div");
      live.id = "oobe-live";
      live.className = "oobe-sr";
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      document.body.appendChild(live);
    }
    live.textContent = "";
    setTimeout(function () { live.textContent = text; }, 60);
  }
  function stepSaid(id, title) {
    var p = placeOf(id);
    return p.label ? t("stepSay", { n: p.n + 1, total: p.total, title: title }) : title;
  }
  /* Move focus to the new step: the field on a desktop text step so typing
     starts at once, the title everywhere else so a screen reader reads it. */
  function focusStep(scope, preferField) {
    var box = scope || document;
    var field = preferField && finePointer() ? box.querySelector(".oobe-main input[type=text]:not([readonly]), .oobe-main input[type=password]:not([readonly])") : null;
    var target = field || box.querySelector("#oobe-title");
    if (!target) return;
    try { target.focus({ preventScroll: true }); } catch (err) { target.focus(); }
  }
  /* Run a DOM update as a shared-axis move. The View Transitions API gives
     a real crossfade of the old and new step; without it the new step's
     enter class slides it in. */
  var vtBusy = null;
  var inUpdate = false;
  function transition(update, dir) {
    if (inUpdate) { update(); return; }
    var html = document.documentElement;
    html.setAttribute("data-oobe-dir", dir < 0 ? "back" : "fwd");
    if (vtBusy) { try { vtBusy.skipTransition(); } catch (err) { /* already done */ } vtBusy = null; }
    if (typeof document.startViewTransition === "function" && !document.hidden) {
      html.setAttribute("data-oobe-vt", "1");
      var done = function () { if (vtBusy === vt) { vtBusy = null; html.removeAttribute("data-oobe-vt"); } };
      var vt = null;
      try {
        vt = document.startViewTransition(function () {
          inUpdate = true;
          try { update(); } finally { inUpdate = false; }
        });
        vtBusy = vt;
        vt.finished.then(done, done);
        return;
      } catch (err) { html.removeAttribute("data-oobe-vt"); }
    }
    html.removeAttribute("data-oobe-vt");
    update();
  }
  /* Shake the step after a failed check. */
  function shake(scope) {
    var el = (scope || document).querySelector(".oobe-main");
    if (!el || reducedMotion()) return;
    el.classList.remove("oobe-shake");
    void el.offsetWidth;
    el.classList.add("oobe-shake");
  }
  /* Keep the full-screen layout the height of what is visible above the
     on-screen keyboard, without layout jumps. */
  var vvBound = false;
  function bindViewport() {
    if (vvBound) return;
    vvBound = true;
    var vv = window.visualViewport;
    function fit() {
      var h = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty("--oobe-vh", Math.round(h) + "px");
    }
    fit();
    if (vv) vv.addEventListener("resize", fit);
    window.addEventListener("resize", fit);
  }

  function primary(label, act, disabled, extra) {
    return '<button class="oobe-btn" type="button" data-onb="' + act + '"' + (disabled ? " disabled" : "") + (state.busy ? ' aria-busy="true"' : "") + (extra || "") + ">" + esc(label) + "</button>";
  }
  function quiet(label, act, extra) {
    return '<button class="oobe-link" type="button" data-onb="' + act + '"' + (extra || "") + ">" + esc(label) + "</button>";
  }
  function backBtn() {
    return '<button class="oobe-icon" type="button" data-onb="back" aria-label="' + esc(t("back")) + '">' + icon("back") + "</button>";
  }
  function closeBtn() {
    return '<button class="oobe-icon" type="button" data-onb="close" aria-label="' + esc(t("close")) + '">' + icon("close") + "</button>";
  }
  function skipBtn() {
    return '<button class="oobe-skip" type="button" data-onb="skip">' + esc(t("skip")) + "</button>";
  }
  function stepName() {
    return state.stage === "pre" ? PRE[state.step] : POST[state.step];
  }

  function ensureRoot() {
    if (root && root.isConnected) return root;
    root = document.createElement("div");
    root.id = "onb-layer";
    document.body.appendChild(root);
    root.addEventListener("click", onClick);
    root.addEventListener("input", onInput);
    root.addEventListener("change", onChange);
    root.addEventListener("keydown", onKey);
    return root;
  }

  function welcomeHtml() {
    var words = HELLO.map(function (w, i) { return '<span style="--i:' + i + '"' + (i ? ' aria-hidden="true"' : "") + ">" + esc(w) + "</span>"; }).join("");
    var temp = accounts() && accounts().openTemp ? quiet(t("tryTemp"), "temp", ' data-onb-temp="1"') : "";
    return shell({
      step: "welcome",
      center: true,
      left: closeBtn(),
      top: '<div class="oobe-hero" aria-hidden="true">' + mark("oobe-hero-mark") + '</div><div class="oobe-hello" style="--n:' + HELLO.length + '">' + words + "</div>",
      title: t("welcome", { app: appName() }),
      sub: t("welcomeSub"),
      foot: primary(t("start"), "next") +
        '<div class="oobe-alt"><p>' + esc(t("quickHint")) + " " + quiet(t("quick"), "quick") + "</p><p>" + esc(t("haveAccount")) + " " + quiet(t("signIn"), "login") + "</p></div>" + temp
    });
  }
  function languageHtml() {
    var picked = lang();
    var guess = detectLang();
    var rows = LANGS.map(function (code) {
      var on = code === picked;
      return '<button class="oobe-opt' + (on ? " on" : "") + '" type="button" role="radio" aria-checked="' + (on ? "true" : "false") + '" data-onb="lang" data-lang="' + code + '" lang="' + code + '"><span class="oobe-opt-text"><b>' + esc(NATIVE[code]) + "</b>" + (code === guess ? "<small>" + esc(t("suggested")) + "</small>" : "") + '</span><span class="oobe-radio" aria-hidden="true"></span></button>';
    }).join("");
    var region = regionName();
    return shell({
      step: "language",
      icon: "globe",
      left: backBtn(),
      title: t("langTitle"),
      sub: t("langSub"),
      body: '<div class="oobe-opts" role="radiogroup" aria-label="' + esc(t("langTitle")) + '">' + rows + "</div>" +
        '<p class="oobe-note">' + esc(t("region")) + (region ? ": " + esc(region) : "") + ". " + esc(t("regionNote")) + "</p>",
      foot: primary(t("next"), "next")
    });
  }
  function chooseHtml() {
    function card(act, ico, title, sub) {
      return '<button class="oobe-opt oobe-card-opt" type="button" data-onb="' + act + '"><span class="oobe-opt-ico">' + icon(ico) + '</span><span class="oobe-opt-text"><b>' + esc(title) + "</b><small>" + esc(sub) + "</small></span>" + icon("chev", "oobe-chev") + "</button>";
    }
    var temp = accounts() && accounts().openTemp ? card("temp", "clock", t("tryTemp"), t("tempS")) : "";
    return shell({
      step: "choose",
      icon: "user",
      left: backBtn(),
      title: t("chooseTitle"),
      sub: t("chooseSub"),
      body: '<div class="oobe-opts">' + card("create", "plus", t("createT"), t("createS")) + card("login", "signin", t("loginT"), t("loginS")) + temp + "</div>"
    });
  }
  function shapeNow() {
    var api = setup();
    var v = api && api.get ? api.get("avatarShape") : "";
    return v === "square" ? "square" : "round";
  }
  function profileHtml() {
    var account = accounts() && accounts().account ? accounts().account() : null;
    if (!state.nameTouched) state.name = account && account.displayName ? account.displayName : state.name;
    var shape = shapeNow();
    var face = state.photo ? '<img alt="" src="' + esc(state.photo) + '">' : (account && account.avatar && /^https:|^data:image\//.test(account.avatar) ? '<img alt="" src="' + esc(account.avatar) + '">' : '<span class="oobe-silhouette">' + icon("user") + "</span>");
    function shapeBtn(mode, label) {
      return '<button class="oobe-seg' + (shape === mode ? " on" : "") + '" type="button" role="radio" aria-checked="' + (shape === mode ? "true" : "false") + '" data-onb="shape" data-mode="' + mode + '"><span class="oobe-seg-ico ' + mode + '" aria-hidden="true"></span>' + esc(label) + "</button>";
    }
    var note = state.photoError ? '<p class="oobe-error" role="alert">' + esc(state.photoError) + "</p>" : (state.note ? '<p class="oobe-note" role="status">' + esc(state.note) + "</p>" : "");
    return shell({
      step: "profile",
      right: skipBtn(),
      title: t("photoTitle"),
      sub: t("photoSub"),
      body: '<div class="oobe-ava-wrap"><label class="oobe-ava ' + shape + '"><input class="oobe-file" type="file" accept="image/*" data-onb-file aria-label="' + esc(state.photo ? t("photoChange") : t("photoAdd")) + '">' + face + '<span class="oobe-cam">' + icon("camera") + "</span></label></div>" +
        '<div class="oobe-segs" role="radiogroup" aria-label="' + esc(t("shape")) + '">' + shapeBtn("round", t("round")) + shapeBtn("square", t("square")) + "</div>" +
        '<label class="oobe-field"><span>' + esc(t("name")) + '</span><input type="text" name="onbName" maxlength="50" autocomplete="name" autocapitalize="words" enterkeyhint="next" value="' + esc(state.name || "") + '"></label>' + note,
      foot: primary(state.busy ? t("saving") : t("next"), "next", state.busy)
    });
  }
  /* Themes come from window.ViktorychThemes: the three base looks plus any
     flag themes. Without it, only the base three. */
  function themes() {
    var T = window.ViktorychThemes;
    return T && T.base ? T : { base: { default: 1, dim: 1, lightsout: 1 }, flags: {} };
  }
  function knownTheme(mode) {
    var T = themes();
    return !!(mode && ((T.base && T.base[mode]) || (T.flags && T.flags[mode])));
  }
  function themeLabel(id) {
    if (id === "default") return t("themeDefault");
    if (id === "dim") return t("themeDim");
    if (id === "lightsout") return t("themeDark");
    var f = themes().flags[id] || {};
    var name = f.name || id;
    return typeof window.t === "function" ? window.t(name) : name;
  }
  function themeNow() {
    var mode = document.documentElement.getAttribute("data-theme") || "lightsout";
    return knownTheme(mode) ? mode : "lightsout";
  }
  function themeHtml() {
    var theme = themeNow();
    function themeBtn(mode, label) {
      var flag = themes().flags[mode];
      var swatch = flag && flag.flag ? '<span class="oobe-swatch is-flag" aria-hidden="true" style="background:linear-gradient(' + flag.flag.map(function (c, i, all) { var a = Math.round(i * 100 / all.length), b = Math.round((i + 1) * 100 / all.length); return esc(c) + " " + a + "% " + b + "%"; }).join(", ") + ')"></span>' : '<span class="oobe-swatch t-' + esc(mode) + '" aria-hidden="true"><i></i><i></i></span>';
      var on = theme === mode;
      return '<button class="oobe-theme' + (on ? " on" : "") + '" type="button" role="radio" aria-checked="' + (on ? "true" : "false") + '" data-onb="theme" data-mode="' + esc(mode) + '">' + swatch + "<span>" + esc(label) + "</span></button>";
    }
    var account = accounts() && accounts().account ? accounts().account() : null;
    var who = account && account.displayName ? account.displayName : t("previewName");
    var handle = account && account.handle ? "@" + account.handle : "";
    var preview = '<div class="oobe-preview" aria-hidden="true"><span class="oobe-preview-ava">' + icon("user") + '</span><div class="oobe-preview-body"><p><b>' + esc(who) + "</b> <span>" + esc(handle) + ' · 1m</span></p><p>' + esc(t("previewText")) + '</p><div class="oobe-preview-bar"><i></i><i></i><i class="hot"></i><i></i></div></div></div>';
    return shell({
      step: "theme",
      icon: "theme",
      left: backBtn(),
      right: skipBtn(),
      title: t("themeTitle"),
      sub: t("themeSub"),
      body: preview + '<div class="oobe-themes" role="radiogroup" aria-label="' + esc(t("theme")) + '">' + ["default", "dim", "lightsout"].concat(Object.keys(themes().flags || {})).map(function (id) { return themeBtn(id, themeLabel(id)); }).join("") + "</div>",
      foot: primary(t("next"), "next")
    });
  }
  function saverOn() {
    var saver = window.ViktorychDataSaver;
    if (state.saver != null) return state.saver;
    if (saver && saver.isOn && saver.isOn()) return true;
    var api = setup();
    if (api && api.get && (api.get("saveData") === true || api.get("dataSaver") === true)) return true;
    if (saver && saver.detect) {
      try { return !!saver.detect().on; } catch (err) { /* fall through */ }
    }
    return false;
  }
  function dataHtml() {
    var on = saverOn();
    function card(value, ico, title, sub) {
      var picked = value === on;
      return '<button class="oobe-opt' + (picked ? " on" : "") + '" type="button" role="radio" aria-checked="' + (picked ? "true" : "false") + '" data-onb="saver" data-on="' + (value ? "1" : "0") + '"><span class="oobe-opt-ico">' + icon(ico) + '</span><span class="oobe-opt-text"><b>' + esc(title) + "</b><small>" + esc(sub) + '</small></span><span class="oobe-radio" aria-hidden="true"></span></button>';
    }
    return shell({
      step: "data",
      icon: "data",
      left: backBtn(),
      right: skipBtn(),
      title: t("dataTitle"),
      sub: t("dataSub"),
      body: '<div class="oobe-opts" role="radiogroup" aria-label="' + esc(t("dataTitle")) + '">' + card(false, "sun", t("dataStd"), t("dataStdSub")) + card(true, "leaf", t("saver"), t("saverSub")) + "</div>",
      foot: primary(t("next"), "next")
    });
  }
  function notifyState() {
    if (state.notify) return state.notify;
    var api = setup();
    if (api && api.notifyState) return api.notifyState();
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission;
  }
  function notifyHtml() {
    var s = notifyState();
    var note = s === "on" || s === "granted" ? t("notifyDone") : s === "unsupported" ? t("notifyNo") : s === "denied" ? t("notifyBlocked") : "";
    var asked = !!note;
    return shell({
      step: "notify",
      icon: "bell",
      left: backBtn(),
      right: skipBtn(),
      title: t("notifyTitle"),
      sub: t("notifySub"),
      body: '<div class="oobe-bell' + (s === "on" || s === "granted" ? " on" : "") + '" aria-hidden="true">' + icon("bell", "oobe-bell-ico") + "<i></i><i></i></div>" + (note ? '<p class="oobe-note" role="status">' + esc(note) + "</p>" : ""),
      foot: asked ? primary(t("next"), "next") : primary(state.busy ? t("saving") : t("notifyOn"), "notify-on", state.busy) + quiet(t("notNow"), "skip", ' data-onb-later="1"')
    });
  }
  function installInfo() {
    var api = setup();
    if (api && api.installInfo) return api.installInfo();
    var standalone = false;
    try { standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; } catch (err) { standalone = false; }
    return { standalone: standalone, kind: "hint", prompt: !!window.__VIKTORYCH_INSTALL };
  }
  function installHtml() {
    var info = installInfo();
    var body = "";
    var foot = "";
    if (info.kind === "ios-safari") {
      body = '<ol class="oobe-steps"><li>' + esc(t("installIos1")) + "</li><li>" + esc(t("installIos2")) + "</li><li>" + esc(t("installIos3")) + "</li></ol>";
      foot = primary(t("next"), "next");
    } else if (info.kind === "ios-browser") {
      body = '<p class="oobe-note">' + esc(t("installIosBrowser")) + "</p>";
      foot = primary(t("next"), "next");
    } else if (info.prompt) {
      foot = primary(t("install"), "install-go") + quiet(t("notNow"), "skip", ' data-onb-later="1"');
    } else {
      body = '<p class="oobe-note">' + esc(t("installHint")) + "</p>";
      foot = primary(t("next"), "next");
    }
    if (state.installNote) body += '<p class="oobe-note" role="status">' + esc(state.installNote) + "</p>";
    return shell({
      step: "install",
      icon: "phone",
      left: backBtn(),
      right: info.prompt ? "" : skipBtn(),
      title: t("installTitle", { app: appName() }),
      sub: t("installSub"),
      body: '<div class="oobe-device" aria-hidden="true"><span>' + mark("oobe-device-mark") + "</span></div>" + body,
      foot: foot
    });
  }
  function followRows() {
    var api = setup();
    var list = api && api.suggestions ? api.suggestions(8) : [];
    /* Keep accounts followed on this screen in the list after the tap. */
    Object.keys(state.follows).forEach(function (id) {
      if (!list.some(function (f) { return f.id === id; }) && state.follows[id]) list.push(state.follows[id]);
    });
    return list;
  }
  function followHtml() {
    var api = setup();
    var list = followRows();
    var ready = !!(api && api.ready && api.ready());
    var body;
    if (!list.length) {
      body = '<p class="oobe-note" role="status">' + esc(ready ? t("none") : t("finding")) + "</p>" + (ready ? "" : '<div class="oobe-skel"><i></i><i></i><i></i></div>');
      if (!ready) waitForData();
    } else {
      body = '<ul class="oobe-people">' + list.map(function (f) {
        var on = !!(state.follows[f.id] || (api.isFollowed && api.isFollowed(f.id)));
        var letter = String(f.name || f.handle || "?").trim().charAt(0).toUpperCase() || "?";
        var pic = f.avatar ? '<img alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" src="' + esc(f.avatar) + '">' : "<span>" + esc(letter) + "</span>";
        return '<li class="oobe-person"><span class="oobe-pic">' + pic + '</span><span class="oobe-who"><b>' + esc(f.name || f.handle) + "</b><small>" + (f.handle ? "@" + esc(f.handle) : "") + (f.platform ? " · " + esc(f.platform) : "") + '</small></span><button class="oobe-follow' + (on ? " on" : "") + '" type="button" data-onb="follow" data-id="' + esc(f.id) + '" aria-pressed="' + (on ? "true" : "false") + '">' + esc(on ? t("following") : t("follow")) + "</button></li>";
      }).join("") + "</ul>";
    }
    return shell({
      step: "follow",
      icon: "people",
      left: backBtn(),
      right: skipBtn(),
      title: t("followTitle"),
      sub: t("followSub"),
      body: body,
      foot: primary(t("next"), "next")
    });
  }
  /* Settings steps. Each row is wired to a setting the app already has:
     the account (protected, private follow lists), People you may know
     (discoverable), presence (who sees you online), the local settings
     (accent, font size, Live Translate, autoplay, vibration) and the
     notification privacy. Defaults show what the account has now. */
  function account() {
    var api = accounts();
    return api && api.account ? api.account() : null;
  }
  function setting(key, fallback) {
    var api = setup();
    var v = api && api.get ? api.get(key) : undefined;
    return v === undefined || v === null ? fallback : v;
  }
  function prefNow(key) {
    if (Object.prototype.hasOwnProperty.call(state.prefs, key)) return state.prefs[key];
    var me = account() || {};
    if (key === "protected") return !!me.protected;
    if (key === "privateFollows") return !!me.privateFollows;
    if (key === "discoverable") {
      var P = window.ViktorychPYMK;
      return P && P.discoverable ? P.discoverable() !== false : true;
    }
    if (key === "online") {
      var pr = window.ViktorychPresence;
      return !(pr && pr.seenPrivacy && pr.seenPrivacy() === "nobody");
    }
    if (key === "friends") {
      var F = window.ViktorychFriendsPref;
      return !(F && F.isOff && F.isOff());
    }
    if (key === "translateAuto") return setting("translateAuto", true) !== false;
    if (key === "haptics") return setting("haptics", true) !== false;
    if (key === "names" || key === "preview") {
      var api = setup();
      var np = api && api.notifPrivacy ? api.notifPrivacy() : null;
      return !np || np[key] !== false;
    }
    return false;
  }
  function toggleRow(key, label) {
    var on = !!prefNow(key);
    return '<button class="oobe-toggle' + (on ? " on" : "") + '" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '" data-onb="pref" data-id="' + esc(key) + '"><span>' + esc(label) + '</span><i aria-hidden="true"></i></button>';
  }
  function noteHtml() {
    return state.note ? '<p class="oobe-note" role="status">' + esc(state.note) + "</p>" : "";
  }
  function friendsRow() {
    var F = window.ViktorychFriendsPref;
    if (!(F && F.available && F.available() && F.setEnabled)) return "";
    // X-native settings row: title, muted description, X check box.
    var on = !!prefNow("friends");
    return '<button class="oobe-toggle oobe-xrow' + (on ? " on" : "") + '" type="button" role="checkbox" aria-checked="' + (on ? "true" : "false") + '" data-onb="pref" data-id="friends">' +
      '<span class="oobe-xcopy"><b>' + esc(t("friendsSwitch")) + '</b><small>' + esc(t("friendsSwitchSub")) + '</small></span>' +
      '<span class="oobe-xcheck' + (on ? " on" : "") + '" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9.64 18.952l-5.55-4.861 1.317-1.504 3.951 3.459 8.459-10.948L19.4 6.32 9.64 18.952z"/></svg></span></button>';
  }
  function privacyHtml() {
    return shell({
      step: "privacy",
      icon: "lock",
      left: backBtn(),
      right: skipBtn(),
      title: t("privacyTitle"),
      sub: t("privacySub"),
      body: '<div class="oobe-toggles">' + toggleRow("protected", t("protect")) + toggleRow("privateFollows", t("privateLists")) + toggleRow("discoverable", t("discover")) + toggleRow("online", t("online")) + friendsRow() + "</div>" + noteHtml(),
      foot: primary(t("next"), "next") + quiet(t("skipAll"), "skip-all")
    });
  }
  var ACCENTS = { blue: "#1d9bf0", yellow: "#ffd400", pink: "#f91880", purple: "#7856ff", orange: "#ff7a00", green: "#00ba7c" };
  var ACCENT_KEYS = { blue: "cBlue", yellow: "cYellow", pink: "cPink", purple: "cPurple", orange: "cOrange", green: "cGreen" };
  var SIZES = [14, 15, 16, 17, 18];
  function lookHtml() {
    var accent = ACCENTS[setting("accent", "blue")] ? setting("accent", "blue") : "blue";
    var size = SIZES.indexOf(Number(setting("fontSize", 15))) >= 0 ? Number(setting("fontSize", 15)) : 15;
    var swatches = Object.keys(ACCENTS).map(function (id) {
      var on = id === accent;
      return '<button class="oobe-accent' + (on ? " on" : "") + '" type="button" role="radio" aria-checked="' + (on ? "true" : "false") + '" aria-label="' + esc(t(ACCENT_KEYS[id])) + '" data-onb="accent" data-mode="' + id + '" style="--sw:' + ACCENTS[id] + '">' + (on ? icon("check") : "") + "</button>";
    }).join("");
    var sizes = SIZES.map(function (n) {
      var on = n === size;
      return '<button class="oobe-size' + (on ? " on" : "") + '" type="button" role="radio" aria-checked="' + (on ? "true" : "false") + '" aria-label="' + n + 'px" data-onb="size" data-mode="' + n + '" style="font-size:' + n + 'px">Aa</button>';
    }).join("");
    return shell({
      step: "look",
      icon: "palette",
      left: backBtn(),
      right: skipBtn(),
      title: t("lookTitle"),
      sub: t("lookSub"),
      body: '<p class="oobe-label">' + esc(t("accent")) + '</p><div class="oobe-accents" role="radiogroup" aria-label="' + esc(t("accent")) + '">' + swatches + "</div>" +
        '<p class="oobe-label">' + esc(t("textSize")) + '</p><div class="oobe-sizes" role="radiogroup" aria-label="' + esc(t("textSize")) + '">' + sizes + "</div>",
      foot: primary(t("next"), "next")
    });
  }
  function contentHtml() {
    var mode = setting("autoplay", "all");
    if (mode !== "wifi" && mode !== "never") mode = "all";
    function apBtn(id, label) {
      var on = id === mode;
      return '<button class="oobe-seg' + (on ? " on" : "") + '" type="button" role="radio" aria-checked="' + (on ? "true" : "false") + '" data-onb="autoplay" data-mode="' + id + '">' + esc(label) + "</button>";
    }
    return shell({
      step: "content",
      icon: "play",
      left: backBtn(),
      right: skipBtn(),
      title: t("contentTitle"),
      sub: t("contentSub"),
      body: '<div class="oobe-toggles">' + toggleRow("translateAuto", t("translate")) + "</div>" +
        '<p class="oobe-label">' + esc(t("autoplay")) + '</p><div class="oobe-segs is-three" role="radiogroup" aria-label="' + esc(t("autoplay")) + '">' + apBtn("all", t("apAll")) + apBtn("wifi", t("apWifi")) + apBtn("never", t("apNever")) + "</div>",
      foot: primary(t("next"), "next")
    });
  }
  function alertsHtml() {
    return shell({
      step: "alerts",
      icon: "vibrate",
      left: backBtn(),
      right: skipBtn(),
      title: t("alertsTitle"),
      sub: t("alertsSub"),
      body: '<div class="oobe-toggles">' + toggleRow("haptics", t("vibrate")) + toggleRow("names", t("notifNames")) + toggleRow("preview", t("notifPreview")) + "</div>",
      foot: primary(t("next"), "next")
    });
  }
  /* Server-backed rows flip at once and roll back if the save fails. */
  function savePref(key, on) {
    var api = setup();
    var acc = accounts();
    var token = acc && acc.token ? acc.token() : "";
    state.prefs[key] = on;
    state.note = "";
    function failed() {
      state.prefs[key] = !on;
      if (state.open) { state.note = t("saveFail"); paint(); }
    }
    if (key === "protected" || key === "privateFollows") {
      var body = {};
      body[key] = on;
      sendProfile(body).then(function (ok) { if (!ok) failed(); });
    } else if (key === "discoverable") {
      var P = window.ViktorychPYMK;
      if (P && P.setDiscoverable) P.setDiscoverable(on).then(function (ok) { if (!ok) failed(); });
      else if (acc && acc.call && token) acc.call("/v1/suggestions/prefs", { method: "PUT", token: token, body: { discoverable: on } }).then(function (res) { if (!res || res.status !== 200) failed(); }, failed);
      else failed();
    } else if (key === "online") {
      var pr = window.ViktorychPresence;
      var value = on ? "everyone" : "nobody";
      if (pr && pr.setSeenPrivacy) pr.setSeenPrivacy(value).then(function (ok) { if (!ok) failed(); });
      else if (acc && acc.call && token) acc.call("/v1/presence", { method: "PATCH", token: token, body: { seenPrivacy: value } }).then(function (res) { if (!res || res.status !== 200) failed(); }, failed);
      else failed();
    } else if (key === "friends") {
      var F = window.ViktorychFriendsPref;
      if (F && F.setEnabled) F.setEnabled(on).then(function (ok) { if (!ok) failed(); });
      else failed();
    } else if (key === "translateAuto" || key === "haptics") {
      var patch = {};
      patch[key] = on;
      if (api && api.set) api.set(patch);
    } else if (key === "names" || key === "preview") {
      var np = {};
      np[key] = on;
      if (api && api.setNotifPrivacy) api.setNotifPrivacy(np);
    }
    paint();
  }
  function doneHtml() {
    var rings = reducedMotion() ? "" : '<span class="oobe-burst" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>';
    return shell({
      step: "done",
      center: true,
      top: '<div class="oobe-done" aria-hidden="true">' + rings + '<span class="oobe-done-ring"></span>' + icon("check", "oobe-done-tick") + "</div>",
      title: t("doneTitle"),
      sub: t("doneSub"),
      foot: primary(t("doneBtn"), "finish")
    });
  }

  function html() {
    var name = stepName();
    if (name === "welcome") return welcomeHtml();
    if (name === "language") return languageHtml();
    if (name === "choose") return chooseHtml();
    if (name === "profile") return profileHtml();
    if (name === "privacy") return privacyHtml();
    if (name === "theme") return themeHtml();
    if (name === "look") return lookHtml();
    if (name === "content") return contentHtml();
    if (name === "data") return dataHtml();
    if (name === "notify") return notifyHtml();
    if (name === "alerts") return alertsHtml();
    if (name === "install") return installHtml();
    if (name === "follow") return followHtml();
    return doneHtml();
  }
  /* Draw the current step. A new step moves on the shared axis; a change on
     the same step (a tapped option, a typed name) redraws in place and keeps
     focus where it was. */
  function paint() {
    if (!state.open) return;
    var el = ensureRoot();
    var name = stepName();
    var moved = state.painted !== name;
    var active = document.activeElement;
    var keep = "";
    if (!moved && active && el.contains(active)) {
      if (active.name) keep = '[name="' + String(active.name).replace(/[^A-Za-z]/g, "") + '"]';
      else if (active.id === "oobe-title") keep = "#oobe-title";
      else if (active.getAttribute("data-onb")) {
        keep = '[data-onb="' + active.getAttribute("data-onb").replace(/[^a-z-]/g, "") + '"]';
        ["data-lang", "data-mode", "data-id", "data-on"].forEach(function (attr) {
          var v = active.getAttribute(attr);
          if (v) keep += "[" + attr + '="' + String(v).replace(/["\\]/g, "") + '"]';
        });
      }
    }
    var caret = active && typeof active.selectionStart === "number" ? active.selectionStart : null;
    function update() {
      el.innerHTML = html();
      document.documentElement.setAttribute("data-onb-open", "1");
      state.painted = name;
      if (moved) {
        var title = el.querySelector("#oobe-title");
        announce(stepSaid(name, title ? title.textContent : ""));
        focusStep(el, name === "profile" ? false : true);
        return;
      }
      var target = null;
      if (keep) { try { target = el.querySelector(keep); } catch (err) { target = null; } }
      if (target && target.focus) {
        try { target.focus({ preventScroll: true }); } catch (err) { target.focus(); }
        if (caret != null && target.setSelectionRange) { try { target.setSelectionRange(caret, caret); } catch (err) { /* not a text field */ } }
      }
    }
    if (moved && el.firstChild) transition(update, state.dir);
    else update();
  }

  function go(stage, step, dir) {
    state.stage = stage;
    state.step = step;
    state.dir = dir || 1;
    state.note = "";
    state.photoError = "";
    state.installNote = "";
    state.busy = false;
    if (stage === "post" && POST[step] === "install" && installInfo().standalone) {
      state.step = step + (dir < 0 ? -1 : 1);
    }
    save();
    paint();
  }
  function close(clear) {
    state.open = false;
    state.painted = "";
    clearTimeout(state.waitTimer);
    if (clear) writeDoc(null);
    document.documentElement.removeAttribute("data-onb-open");
    if (root) root.innerHTML = "";
  }
  /* Hand over to accounts.js for the account steps, as a forward move. */
  function toAccount() {
    state.stage = "account";
    state.step = 0;
    save();
    var api = accounts();
    var el = root;
    transition(function () {
      close(false);
      if (api && api.openSignupSetup) api.openSignupSetup();
    }, 1);
    return el;
  }
  function applyLang(code) {
    state.lang = code;
    try {
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      if (window.SI18n && window.SI18n.setLang) window.SI18n.setLang(code);
      /* A language the page does not ship yet still sticks for later. */
      localStorage.setItem("superintelapp-lang", code);
    } catch (err) { /* this page still switches */ }
    save();
  }
  function waitForData() {
    clearTimeout(state.waitTimer);
    var tries = 0;
    function tick() {
      tries += 1;
      if (!state.open || stepName() !== "follow") return;
      var api = setup();
      if ((api && api.ready && api.ready()) || tries > 20) { paint(); return; }
      state.waitTimer = setTimeout(tick, 600);
    }
    state.waitTimer = setTimeout(tick, 600);
  }

  /* Profile: square-crop the picked photo to 400px WebP under 60 KB, as the
     editor in accounts.js does, then PATCH name and picture. */
  function encode(canvas) {
    var quality = 0.82;
    return new Promise(function (resolve) {
      function step() {
        if (!canvas.toBlob) { resolve(null); return; }
        canvas.toBlob(function (blob) {
          if (!blob || blob.type !== "image/webp") { resolve(null); return; }
          if (blob.size <= 60 * 1024) resolve(blob);
          else if (quality <= 0.42) resolve(null);
          else { quality = Math.round((quality - 0.08) * 100) / 100; step(); }
        }, "image/webp", quality);
      }
      step();
    });
  }
  function readPhoto(file) {
    state.photoError = "";
    if (!file || !/^image\//.test(file.type || "") || file.size > 25 * 1024 * 1024) {
      state.photoError = t("photoFail");
      paint();
      return;
    }
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      var side = Math.min(img.naturalWidth, img.naturalHeight);
      var canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 400;
      canvas.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 400, 400);
      URL.revokeObjectURL(url);
      encode(canvas).then(function (blob) {
        if (!blob) { state.photoError = t("photoFail"); paint(); return; }
        var reader = new FileReader();
        reader.onload = function () { state.photo = String(reader.result || ""); paint(); };
        reader.onerror = function () { state.photoError = t("photoFail"); paint(); };
        reader.readAsDataURL(blob);
      });
    };
    img.onerror = function () { URL.revokeObjectURL(url); state.photoError = t("photoFail"); paint(); };
    img.src = url;
  }
  function sendProfile(body) {
    var api = accounts();
    var token = api && api.token ? api.token() : "";
    if (!api || !api.call || !token) return Promise.resolve(false);
    return api.call("/v1/profile", { method: "PATCH", token: token, body: body }).then(function (res) {
      if (!res || res.status !== 200 || !res.account) return false;
      if (api.saveOwnAccount) api.saveOwnAccount(res);
      return true;
    }).catch(function () { return false; });
  }
  function retryProfileLater(body) {
    state.pendingProfile = body;
    function again() {
      if (!state.pendingProfile) return;
      sendProfile(state.pendingProfile).then(function (ok) { if (ok) { state.pendingProfile = null; window.removeEventListener("online", again); } });
    }
    window.addEventListener("online", again);
  }
  function submitProfile() {
    var account = accounts() && accounts().account ? accounts().account() : null;
    var body = {};
    var name = String(state.name || "").trim();
    if (name && (!account || name !== account.displayName)) body.displayName = name;
    if (state.photo) { body.avatar = state.photo; body.avatarEmpty = "default"; }
    if (!Object.keys(body).length) { forward(); return; }
    state.busy = true;
    paint();
    sendProfile(body).then(function (ok) {
      state.busy = false;
      if (!ok) {
        retryProfileLater(body);
        state.note = t("saveLater");
        paint();
        setTimeout(function () { if (state.open && stepName() === "profile") forward(); }, 1400);
        return;
      }
      forward();
    });
  }
  function setShape(mode) {
    var api = setup();
    if (api && api.set) api.set({ avatarShape: mode });
    if (mode === "square") document.documentElement.setAttribute("data-ava-shape", "square");
    else document.documentElement.removeAttribute("data-ava-shape");
  }
  function setTheme(mode) {
    var api = setup();
    if (api && api.set) api.set({ appearance: mode });
    else {
      var T = window.ViktorychThemes;
      if (T && T.apply) T.apply(mode);
      else document.documentElement.setAttribute("data-theme", mode);
      try {
        var raw = JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}") || {};
        raw.appearance = mode;
        localStorage.setItem("viktorychapp-settings-v1", JSON.stringify(raw));
      } catch (err) { /* the theme still shows on this page */ }
    }
  }
  function applySaver() {
    var on = saverOn();
    var saver = window.ViktorychDataSaver;
    if (saver && saver.apply) {
      var already = saver.isOn ? !!saver.isOn() : null;
      if (already !== on) { try { saver.apply(on); } catch (err) { /* settings still open */ } }
      return;
    }
    var api = setup();
    if (api && api.set) api.set({ saveData: on });
  }
  function askNotify() {
    var api = setup();
    if (typeof Notification === "undefined" && !(api && api.enableNotifications)) { state.notify = "unsupported"; paint(); return; }
    state.busy = true;
    paint();
    var ask = api && api.enableNotifications ? api.enableNotifications() : Notification.requestPermission();
    Promise.resolve(ask).then(function (result) {
      state.busy = false;
      state.notify = result === "granted" || result === "on" ? "on" : (typeof Notification === "undefined" ? "unsupported" : (Notification.permission === "default" ? "dismissed" : Notification.permission));
      if (state.notify === "dismissed") { forward(); return; }
      paint();
    }).catch(function () { state.busy = false; state.notify = "unsupported"; paint(); });
  }
  function installNow() {
    var api = setup();
    if (!api || !api.promptInstall) { forward(); return; }
    state.busy = true;
    paint();
    api.promptInstall().then(function () { state.busy = false; forward(); }, function () { state.busy = false; forward(); });
  }
  function installLater() {
    var api = setup();
    if (api && api.installLater) api.installLater();
    else if (window.ViktorychNative && window.ViktorychNative.writeInstallChoice) window.ViktorychNative.writeInstallChoice("later");
  }
  /* The finale zooms the card away and lets the timeline show through. */
  function finish() {
    if (state.leaving) return;
    state.leaving = true;
    var api = setup();
    if (api && api.skipWelcome) api.skipWelcome();
    var card = root && root.querySelector(".oobe");
    var end = function () {
      state.leaving = false;
      close(true);
      lastIndex = { dot: -1, group: -1, step: "" };
      if (api && api.done) api.done();
      try { if (location.hash && location.hash !== "#/") location.hash = "#/"; } catch (err) { /* already home */ }
    };
    if (!card || reducedMotion()) { end(); return; }
    card.classList.add("oobe-leave");
    var done = false;
    var once = function () { if (done) return; done = true; end(); };
    card.addEventListener("animationend", function (e) { if (e.target === card) once(); });
    setTimeout(once, 700);
  }

  function forward() {
    if (state.stage === "pre") { go("pre", Math.min(PRE.length - 1, state.step + 1), 1); return; }
    go("post", Math.min(POST.length - 1, state.step + 1), 1);
  }
  function next() {
    var name = stepName();
    if (name === "welcome") { go("pre", 1, 1); return; }
    if (name === "language") { if (!state.lang) applyLang(lang()); go("pre", 2, 1); return; }
    if (name === "choose") { quickOff(); toAccount(); return; }
    if (name === "profile") { submitProfile(); return; }
    if (name === "theme" || name === "privacy" || name === "look" || name === "content" || name === "alerts") { forward(); return; }
    if (name === "data") { applySaver(); forward(); return; }
    if (name === "notify") { forward(); return; }
    if (name === "install") { if (installInfo().prompt) installNow(); else { installLater(); forward(); } return; }
    if (name === "follow") { forward(); return; }
    finish();
  }
  function skip() {
    var name = stepName();
    if (name === "install") installLater();
    if (name === "done") { finish(); return; }
    if (name === "welcome" || name === "language" || name === "choose") { next(); return; }
    forward();
  }
  /* Skip all: keep the defaults and go straight to the finale. */
  function skipAll() {
    go("post", POST.indexOf("done"), 1);
  }
  function back() {
    if (state.stage === "pre" && state.step > 0) { go("pre", state.step - 1, -1); return; }
    if (state.stage === "post" && state.step > 0 && stepName() !== "done") { go("post", state.step - 1, -1); }
  }
  /* The quick sign-up choice holds for this browser session. */
  var QUICK_KEY = "viktorychapp-setup-mode";
  function quickOff() { try { sessionStorage.removeItem(QUICK_KEY); } catch (err) { /* private mode */ } }
  function quick() {
    try { sessionStorage.setItem(QUICK_KEY, "quick"); } catch (err) { /* only this page remembers */ }
    var api = accounts();
    writeDoc(null);
    transition(function () {
      close(false);
      if (api && api.openQuickSignup) api.openQuickSignup();
    }, 1);
  }
  function onClick(event) {
    var el = event.target && event.target.closest ? event.target.closest("[data-onb]") : null;
    if (!el || el.disabled) return;
    var act = el.getAttribute("data-onb");
    if (act === "next" || act === "create") next();
    else if (act === "skip") skip();
    else if (act === "skip-all") skipAll();
    else if (act === "back") back();
    else if (act === "finish") finish();
    else if (act === "close") close(true);
    else if (act === "quick") quick();
    else if (act === "notify-on") askNotify();
    else if (act === "install-go") installNow();
    else if (act === "temp") {
      var tapi = accounts();
      var from = stepName();
      transition(function () {
        close(false);
        if (tapi && tapi.openTemp) tapi.openTemp(from === "choose" ? "choose" : "welcome");
      }, 1);
    }
    else if (act === "login") {
      quickOff();
      close(true);
      var api = accounts();
      if (api && api.openLogin) api.openLogin();
    } else if (act === "lang") {
      applyLang(el.getAttribute("data-lang") || "en");
      paint();
    } else if (act === "shape") {
      setShape(el.getAttribute("data-mode") === "square" ? "square" : "round");
      paint();
    } else if (act === "theme") {
      var mode = el.getAttribute("data-mode");
      setTheme(knownTheme(mode) ? mode : "lightsout");
      paint();
    } else if (act === "pref") {
      var key = el.getAttribute("data-id") || "";
      if (!/^(protected|privateFollows|discoverable|online|translateAuto|haptics|names|preview|friends)$/.test(key)) return;
      savePref(key, !prefNow(key));
    } else if (act === "accent") {
      var accent = el.getAttribute("data-mode");
      var lapi = setup();
      if (ACCENTS[accent] && lapi && lapi.set) lapi.set({ accent: accent });
      paint();
    } else if (act === "size") {
      var px = Number(el.getAttribute("data-mode"));
      var sapi2 = setup();
      if (SIZES.indexOf(px) >= 0 && sapi2 && sapi2.set) sapi2.set({ fontSize: px });
      paint();
    } else if (act === "autoplay") {
      var ap = el.getAttribute("data-mode");
      var aapi = setup();
      if (aapi && aapi.set) aapi.set({ autoplay: ap === "wifi" || ap === "never" ? ap : "all" });
      paint();
    } else if (act === "saver") {
      state.saver = el.getAttribute("data-on") === "1";
      applySaver();
      paint();
    } else if (act === "follow") {
      var id = el.getAttribute("data-id") || "";
      var sapi = setup();
      if (!id || !sapi || !sapi.follow) return;
      var on = !(state.follows[id] || (sapi.isFollowed && sapi.isFollowed(id)));
      var row = followRows().filter(function (f) { return f.id === id; })[0] || { id: id };
      if (on) state.follows[id] = row; else delete state.follows[id];
      sapi.follow(id, on);
      paint();
    }
  }
  function onInput(event) {
    var el = event.target;
    if (el && el.name === "onbName") { state.name = el.value; state.nameTouched = true; }
  }
  function onChange(event) {
    var el = event.target;
    if (el && el.hasAttribute && el.hasAttribute("data-onb-file")) readPhoto(el.files && el.files[0]);
  }
  /* Enter continues, Esc goes back, Tab stays inside the step. */
  function onKey(event) {
    var target = event.target || {};
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      var tag = String(target.tagName || "").toUpperCase();
      if (tag === "BUTTON" || tag === "A" || tag === "TEXTAREA" || (tag === "INPUT" && target.type === "file")) return;
      event.preventDefault();
      var main = root && root.querySelector(".oobe-foot [data-onb]:not([disabled])");
      if (main) main.click();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      var name = stepName();
      if (name === "welcome") close(true);
      else back();
      return;
    }
    if (event.key !== "Tab") return;
    var card = root && root.querySelector(".oobe-card");
    if (!card) return;
    var items = Array.prototype.filter.call(card.querySelectorAll("button, input, a[href], [tabindex='-1']#oobe-title"), function (n) { return !n.disabled && (n.tabIndex !== -1 || n === document.activeElement); });
    items = items.filter(function (n) { return n.id !== "oobe-title" || n === document.activeElement; });
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function start(stage, step, dir) {
    var doc = readDoc() || {};
    state.lang = validLang(doc.lang) || state.lang || "";
    bindViewport();
    if (stage === "account") { state.open = true; toAccount(); return; }
    if (stage === "pre" && !state.lang) state.lang = detectLang();
    var max = stage === "pre" ? PRE.length - 1 : POST.length - 1;
    var n = Math.max(0, Math.min(max, Number(step) || 0));
    /* A saved step name wins over its number, so a resume lands on the
       same screen after steps are added. */
    if (stage === "post" && doc.stage === "post" && Number(doc.step) === Number(step) && POST.indexOf(doc.name) >= 0) n = POST.indexOf(doc.name);
    if (state.open && state.stage === stage && state.step === n) return;
    if (stage === "post") {
      var api = setup();
      if (api && api.skipWelcome) api.skipWelcome();
      if (state.lang && window.SI18n && window.SI18n.getLang && window.SI18n.getLang() !== state.lang && window.SI18n.setLang) {
        try { window.SI18n.setLang(state.lang); } catch (err) { /* keep the page language */ }
      }
    }
    state.open = true;
    go(stage, n, dir || 1);
  }

  window.ViktorychOnboarding = {
    start: start,
    close: function () { close(true); },
    isOpen: function () { return state.open; },
    shell: shell,
    icon: icon,
    mark: mark,
    transition: transition,
    announce: announce,
    stepSaid: stepSaid,
    focusStep: focusStep,
    shake: shake,
    bindViewport: bindViewport,
    reducedMotion: reducedMotion,
    quickKey: QUICK_KEY,
    t: t,
    total: DOTS.length
  };
})();
