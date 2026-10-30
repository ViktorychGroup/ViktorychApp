/* Settings registry: one machine-readable list of every setting in the app.
   The Local AI page reads it to answer "where is X" and to change settings
   with checked tool calls. scripts/settings_registry_test.js fails CI when a
   new setting shows up in app.js, settings-sync.js or accounts.js without an
   entry here, so this list stays complete.

   Fields: id, label (UI words, translated with tr), desc (English, for the
   model), type (bool | enum | number | text | list | object | action),
   values (enum), min/max/step (number), def (default), store (where it
   lives: state = settings-v1 in this browser and synced by settings-sync.js;
   account = the server profile; presence, pymk, notifPrivacy, saver, device,
   lang, module), key (field inside the store), page (deep link), cat, risk
   (safe | privacy | danger), private (the more private value, for privacy
   rows), sync (account | device | server), ai (false = the assistant only
   links to it), words (extra search words in en/es/ru/hi).
   Internal rows (type "data") are app state, not settings; they are listed
   so the completeness test knows about them, and the assistant never edits
   them. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychSettingsRegistry = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  function t(s) { return s; }
  var LIST = [];
  function add(row) { LIST.push(row); return row; }

  /* ---- Look ---- */
  add({ id: "appearance", label: t("Theme"), desc: "Colour theme of the whole app. lightsout = black, dim = dark blue, default = light/white.", type: "enum", values: ["lightsout", "dim", "default"], valueLabels: { lightsout: t("Lights out"), dim: t("Dim"), "default": t("Light") }, def: "lightsout", store: "state", key: "appearance", page: "#/settings/display", cat: "look", risk: "safe", sync: "account",
    words: "theme dark light black white dim night mode colour color background tema oscuro claro negro blanco modo noche тема темная светлая черная белая ночной режим थीम डार्क लाइट काला सफेद", valueWords: { lightsout: "dark black night oscuro negro noche темн черн ночн डार्क काला", dim: "dim blue tenue azul тускл синий धुंधला", "default": "light white bright day claro blanco día светл бел дневн लाइट सफेद" } });
  add({ id: "accent", label: t("Color"), desc: "Accent colour used for buttons, links and highlights.", type: "enum", values: ["blue", "yellow", "pink", "purple", "orange", "green"], valueLabels: { blue: t("Blue"), yellow: t("Yellow"), pink: t("Pink"), purple: t("Purple"), orange: t("Orange"), green: t("Green") }, def: "blue", store: "state", key: "accent", page: "#/customize", cat: "look", risk: "safe", sync: "account",
    words: "accent colour color highlight buttons links acento color resaltado акцент цвет кнопки рंग एक्सेंट रंग", valueWords: { blue: "blue azul син नीला", yellow: "yellow amarillo желт पीला", pink: "pink rosa розов गुलाबी", purple: "purple violet morado фиолет बैंगनी", orange: "orange naranja оранж नारंगी", green: "green verde зелен हरा" } });
  add({ id: "fontSize", label: t("Font size"), desc: "Text size in pixels for posts and menus. 15 is normal.", type: "number", values: [14, 15, 16, 17, 18], min: 14, max: 18, step: 1, def: 15, store: "state", key: "fontSize", page: "#/customize", cat: "look", risk: "safe", sync: "account",
    words: "text font size bigger larger smaller tiny huge read letters texto fuente tamaño grande pequeño letra letras текст шрифт размер крупнее больше меньше мелкий буквы टेक्स्ट फ़ॉन्ट आकार बड़ा छोटा अक्षर" });
  add({ id: "density", label: t("Density"), desc: "Spacing between rows. compact = tighter, comfy = roomier.", type: "enum", values: ["compact", "default", "comfy"], valueLabels: { compact: t("Compact"), "default": t("Default"), comfy: t("Comfortable") }, def: "default", store: "state", key: "density", page: "#/customize", cat: "look", risk: "safe", sync: "account",
    words: "density spacing compact tight roomy dense densidad espaciado compacto плотность отступы компактно घनत्व जगह कॉम्पैक्ट", valueWords: { compact: "compact tight dense less space compacto compacta компакт плотн कॉम्पैक्ट", comfy: "comfortable roomy more space spacious cómodo amplio просторн удобн आरामदायक", "default": "default normal predeterminado обычн सामान्य" } });
  add({ id: "reduceMotion", label: t("Reduce motion"), desc: "Turns off most animations and moving effects.", type: "bool", def: false, store: "state", key: "reduceMotion", page: "#/customize", cat: "look", risk: "safe", sync: "account",
    words: "reduce motion animations animation moving effects dizzy reducir movimiento animaciones уменьшить движение анимации анимация गति कम एनिमेशन" });
  add({ id: "showPictures", label: t("Profile pictures"), desc: "How profile pictures show: show = real photos, default = plain default avatar, none = hidden.", type: "enum", values: ["show", "default", "none"], valueLabels: { show: t("Show"), "default": t("Default"), none: t("None") }, def: "show", store: "state", key: "showPictures", page: "#/settings/display", cat: "look", risk: "safe", sync: "account",
    words: "profile pictures photos avatars faces fotos perfil avatares аватары фото профиля प्रोफ़ाइल फ़ोटो अवतार", valueWords: { show: "show real visible mostrar показ दिखा", "default": "default generic placeholder predeterminado стандарт डिफ़ॉल्ट", none: "none hide hidden no ocultar ninguno скрыть нет छिपा" } });
  add({ id: "showBanners", label: t("Banners"), desc: "How profile banners show: show, default (plain colour) or none.", type: "enum", values: ["show", "default", "none"], valueLabels: { show: t("Show"), "default": t("Default"), none: t("None") }, def: "show", store: "state", key: "showBanners", page: "#/settings/display", cat: "look", risk: "safe", sync: "account",
    words: "banners headers cover images banner portada cabecera баннеры обложка шапка बैनर कवर", valueWords: { show: "show mostrar показ दिखा", "default": "default plain predeterminado стандарт डिफ़ॉल्ट", none: "none hide no ocultar скрыть छिपा" } });
  add({ id: "avatarShape", label: t("Profile picture shape"), desc: "Shape of profile pictures: round or square.", type: "enum", values: ["round", "square"], valueLabels: { round: t("Round"), square: t("Square") }, def: "round", store: "state", key: "avatarShape", page: "#/settings/display", cat: "look", risk: "safe", sync: "account",
    words: "avatar shape round square circle forma redonda cuadrada форма круглая квадратная आकार गोल चौकोर", valueWords: { round: "round circle redond круг गोल", square: "square cuadrad квадрат चौकोर" } });
  add({ id: "haptics", label: t("Haptics"), desc: "Small vibrations when you tap buttons on phones.", type: "bool", def: true, store: "state", key: "haptics", page: "#/settings/display", cat: "look", risk: "safe", sync: "account",
    words: "haptics vibration vibrate buzz tap feedback vibración háptica вибрация тактильный отклик कंपन हैप्टिक" });
  add({ id: "brandLogo", label: t("Sidebar logo"), desc: "Logo in the desktop sidebar: default mark, your own text, or hidden.", type: "object", store: "state", key: "brandLogo", page: "#/settings/display", cat: "look", risk: "safe", sync: "account", ai: false, words: "logo sidebar brand logotipo логотип लोगो" });
  add({ id: "navCustom", label: t("Sidebar"), desc: "Which items the desktop sidebar shows and their order.", type: "object", store: "state", key: "navCustom", page: "#/settings/display/navigation", cat: "look", risk: "safe", sync: "account", ai: false, words: "sidebar menu items order barra lateral боковая панель साइडबार" });
  add({ id: "navCustomAt", label: t("Sidebar"), desc: "Time stamp that travels with the sidebar order.", type: "data", store: "state", key: "navCustomAt", cat: "look", sync: "account", ai: false });
  add({ id: "bottomNav", label: t("Bottom bar"), desc: "Icons in the phone bottom bar and their order.", type: "object", store: "state", key: "bottomNav", page: "#/settings/display/navigation", cat: "look", risk: "safe", sync: "account", ai: false, words: "bottom bar navigation icons tabs barra inferior нижняя панель नीचे की पट्टी" });
  add({ id: "bottomNavCustom", label: t("Bottom bar"), desc: "Whether the bottom bar uses your own order.", type: "data", store: "state", key: "bottomNavCustom", cat: "look", sync: "account", ai: false });
  add({ id: "navLayout", label: t("Navigation layout"), desc: "auto = sidebar on wide screens, bar = always use the bottom bar.", type: "enum", values: ["auto", "bar"], valueLabels: { auto: t("Automatic"), bar: t("Bottom bar") }, def: "auto", store: "state", key: "navLayout", page: "#/settings/display/navigation", cat: "look", risk: "safe", sync: "device",
    words: "navigation layout sidebar bottom bar tablet diseño navegación макет навигации नेविगेशन लेआउट" });
  add({ id: "navLayoutLand", label: t("Bottom bar in landscape"), desc: "Use the bottom bar when the phone is sideways.", type: "bool", def: false, store: "state", key: "navLayoutLand", page: "#/settings/display/navigation", cat: "look", risk: "safe", sync: "device", words: "landscape sideways horizontal horizontal альбомная лैंडस्केप" });
  add({ id: "navLayoutSync", label: t("Same layout on all devices"), desc: "Copy the navigation layout to your other devices.", type: "bool", def: false, store: "state", key: "navLayoutSync", page: "#/settings/display/navigation", cat: "look", risk: "safe", sync: "device", words: "same layout all devices sync mismo diseño todos dispositivos одинаково все устройства सभी डिवाइस" });
  add({ id: "drawerMenu", label: t("Menu order"), desc: "Order, folders and hidden items of the side menu.", type: "object", store: "state", key: "drawerMenu", page: "#/customize", cat: "look", risk: "safe", sync: "account", ai: false, words: "side menu drawer order folders menú lateral меню मेनू" });
  add({ id: "inboxLayout", label: t("Inbox sections"), desc: "Which Inbox sections are merged, split or hidden.", type: "object", store: "state", key: "inboxLayout", page: "#/settings/display/inbox", cat: "look", risk: "safe", sync: "device", ai: false, words: "inbox sections mail sms discord bandeja входящие इनबॉक्स" });
  add({ id: "profileTabs", label: t("Profile tabs"), desc: "Order of the tabs on profiles.", type: "object", store: "state", key: "profileTabs", page: "#/customize", cat: "look", risk: "safe", sync: "account", ai: false, words: "profile tabs order pestañas perfil вкладки профиля प्रोफ़ाइल टैब" });
  add({ id: "keyboard", label: t("Keyboard shortcuts"), desc: "Keyboard shortcut choices on computers.", type: "object", store: "state", key: "keyboard", page: "#/settings/keyboard", cat: "look", risk: "safe", sync: "account", ai: false, words: "keyboard shortcuts keys atajos teclado горячие клавиши клавиатура कीबोर्ड शॉर्टकट" });
  add({ id: "aiFab", label: t("Local AI button"), desc: "Shows a floating Local AI button on every page.", type: "bool", def: false, store: "state", key: "aiFab", page: "#/ai", cat: "look", risk: "safe", sync: "account",
    words: "floating button assistant ai bubble shortcut botón flotante asistente плавающая кнопка ассистент फ्लोटिंग बटन सहायक" });

  /* ---- Feed and media ---- */
  add({ id: "autoplay", label: t("Autoplay videos"), desc: "When videos start playing by themselves. all = always, wifi = only on Wi-Fi (never on mobile data), never = never.", type: "enum", values: ["all", "wifi", "never"], valueLabels: { all: t("On cellular or Wi-Fi"), wifi: t("Only on Wi-Fi"), never: t("Never") }, def: "all", store: "state", key: "autoplay", page: "#/settings/data", cat: "media", risk: "safe", sync: "account",
    words: "autoplay videos play automatically auto play reproducción automática autoreproducción автовоспроизведение видео автоматически ऑटोप्ले वीडियो", valueWords: { all: "always all everywhere siempre всегда हमेशा", wifi: "wifi wi-fi only mobile data cellular datos móviles celular мобильн сотов wifi मोबाइल डेटा", never: "never stop off no nunca detener никогда стоп выключ कभी नहीं बंद" } });
  add({ id: "videoHd", label: t("HD video"), desc: "Play videos in HD when possible. Off saves data.", type: "bool", def: true, store: "state", key: "videoHd", page: "#/settings/data", cat: "media", risk: "safe", sync: "device",
    words: "hd high quality video resolution calidad alta vídeo качество видео hd высокое वीडियो गुणवत्ता एचडी" });
  add({ id: "imageLoad", label: t("Load images"), desc: "always = load images everywhere, wifi = load images only on Wi-Fi.", type: "enum", values: ["always", "wifi"], valueLabels: { always: t("Always"), wifi: t("Only on Wi-Fi") }, def: "always", store: "state", key: "imageLoad", page: "#/settings/data", cat: "media", risk: "safe", sync: "device",
    words: "images photos pictures load imágenes fotos cargar изображения картинки загрузка छवियाँ तस्वीरें", valueWords: { always: "always siempre всегда हमेशा", wifi: "wifi only mobile data datos móviles мобильн मोबाइल डेटा" } });
  add({ id: "imageSize", label: t("Image size"), desc: "auto = full images, small = smaller images that use less data.", type: "enum", values: ["auto", "small"], valueLabels: { auto: t("Automatic"), small: t("Small") }, def: "auto", store: "state", key: "imageSize", page: "#/settings/data", cat: "media", risk: "safe", sync: "device", words: "image size small smaller tamaño imagen pequeño размер изображений छवि आकार" });
  add({ id: "linkPreviews", label: t("Link previews"), desc: "full = cards with pictures, text = text only.", type: "enum", values: ["full", "text"], valueLabels: { full: t("Full"), text: t("Text only") }, def: "full", store: "state", key: "linkPreviews", page: "#/settings/data", cat: "media", risk: "safe", sync: "device", words: "link previews cards vista previa enlaces превью ссылок लिंक प्रीव्यू" });
  add({ id: "preload", label: t("Preload"), desc: "idle = load the next posts in spare time, defer = wait until needed.", type: "enum", values: ["idle", "defer"], valueLabels: { idle: t("In spare time"), defer: t("Only when needed") }, def: "idle", store: "state", key: "preload", page: "#/settings/data", cat: "media", risk: "safe", sync: "device", words: "preload prefetch precarga предзагрузка प्रीलोड" });
  add({ id: "syncEvery", label: t("Refresh speed"), desc: "normal or slow refresh of feeds. Slow saves battery and data.", type: "enum", values: ["normal", "slow"], valueLabels: { normal: t("Normal"), slow: t("Slow") }, def: "normal", store: "state", key: "syncEvery", page: "#/settings/data", cat: "media", risk: "safe", sync: "device", words: "refresh sync often battery actualizar frecuencia обновление частота батарея रिफ्रेश बैटरी" });
  add({ id: "backgroundLive", label: t("Live updates in the background"), desc: "Keep live counts and lives updating while you scroll.", type: "bool", def: true, store: "state", key: "backgroundLive", page: "#/settings/data", cat: "media", risk: "safe", sync: "device", words: "background live updates segundo plano фон обновления बैकग्राउंड" });
  add({ id: "updateDownload", label: t("App updates"), desc: "always = download app updates on any network, wifi = only on Wi-Fi.", type: "enum", values: ["always", "wifi"], valueLabels: { always: t("Always"), wifi: t("Only on Wi-Fi") }, def: "always", store: "state", key: "updateDownload", page: "#/settings/data", cat: "media", risk: "safe", sync: "device", words: "app updates download actualizaciones обновления приложения अपडेट" });
  add({ id: "saveData", label: t("Max data saving"), desc: "One switch that lowers data use: smaller images, no autoplay, slower refresh.", type: "bool", def: false, store: "saver", key: "saveData", page: "#/settings/data", cat: "media", risk: "safe", sync: "device",
    words: "data saver save data mobile data less data ahorro de datos ahorrar datos экономия трафика данных डेटा सेवर डेटा बचत" });
  add({ id: "livePreview", label: t("Live previews"), desc: "Muted live video previews in the feed: auto, on or off.", type: "enum", values: ["auto", "on", "off"], valueLabels: { auto: t("Automatic"), on: t("On"), off: t("Off") }, def: "auto", store: "state", key: "livePreview", page: "#/settings/data", cat: "media", risk: "safe", sync: "account", words: "live previews streams vista previa directos превью трансляций लाइव प्रीव्यू" });
  add({ id: "reactionsData", label: t("Reactions"), desc: "How much reaction data loads: auto, full or lite.", type: "enum", values: ["auto", "full", "lite"], valueLabels: { auto: t("Automatic"), full: t("Full"), lite: t("Light") }, def: "auto", store: "state", key: "reactionsData", page: "#/settings/data", cat: "media", risk: "safe", sync: "account", words: "reactions emoji data reacciones реакции प्रतिक्रियाएँ" });
  add({ id: "communityNotesData", label: t("Community Notes"), desc: "How much Community Notes data loads: auto, full or lite.", type: "enum", values: ["auto", "full", "lite"], valueLabels: { auto: t("Automatic"), full: t("Full"), lite: t("Light") }, def: "auto", store: "state", key: "communityNotesData", page: "#/settings/data", cat: "media", risk: "safe", sync: "account", words: "community notes data notas de la comunidad заметки сообщества" });
  add({ id: "playbackSource", label: t("Playback source"), desc: "Where videos play from: embed (official player), device (direct file) or server.", type: "enum", values: ["embed", "device", "server"], valueLabels: { embed: t("Official player"), device: t("This device"), server: t("Server") }, def: "embed", store: "state", key: "playbackSource", page: "#/settings/network", cat: "media", risk: "safe", sync: "device", words: "playback source player embed reproductor fuente источник воспроизведения प्लेबैक स्रोत" });
  add({ id: "networkMode", label: t("Network mode"), desc: "auto, max (all bypass routes) or direct (no proxy).", type: "enum", values: ["auto", "max", "direct"], valueLabels: { auto: t("Automatic"), max: t("Maximum"), direct: t("Direct") }, def: "auto", store: "state", key: "networkMode", page: "#/settings/network", cat: "network", risk: "safe", sync: "device", words: "proxy vpn bypass censorship blocked network red bloqueo прокси обход сеть प्रॉक्सी नेटवर्क" });
  add({ id: "homePills", label: t("Live pills row"), desc: "Weather, scores and live spaces row above the Home timeline.", type: "bool", def: true, store: "state", key: "homePills", page: "#/settings/display", cat: "feed", risk: "safe", sync: "account", words: "pills weather scores row píldoras clima marcadores плашки погода счет गोलियाँ मौसम स्कोर" });
  add({ id: "stories", label: t("Stories"), desc: "The stories row at the top of Home.", type: "bool", def: true, store: "state", key: "stories", page: "#/settings/display", cat: "feed", risk: "safe", sync: "account", words: "stories row historias истории स्टोरीज़" });
  add({ id: "storyNotes", label: t("Story notes"), desc: "Short notes shown on stories.", type: "bool", def: true, store: "state", key: "storyNotes", page: "#/settings/privacy", cat: "feed", risk: "safe", sync: "account", words: "story notes notas historias заметки историй स्टोरी नोट्स" });
  add({ id: "followingSort", label: t("Following options"), desc: "Following tab order: recent = newest first, popular = top posts first.", type: "enum", values: ["recent", "popular"], valueLabels: { recent: t("Recent"), popular: t("Popular") }, def: "recent", store: "state", key: "followingSort", page: "#/customize", cat: "feed", risk: "safe", sync: "account", words: "following sort order recent popular siguiendo orden подписки сортировка फ़ॉलोइंग क्रम", valueWords: { recent: "recent newest latest chronological reciente новые свежие नवीनतम", popular: "popular top best mejores популярн लोकप्रिय" } });
  add({ id: "forYouReposts", label: t("Show reposts"), desc: "Show reposts in For You.", type: "bool", def: true, store: "state", key: "forYouReposts", page: "#/customize", cat: "feed", risk: "safe", sync: "account", words: "reposts retweets for you reposts para ti репосты для вас रीपोस्ट" });
  add({ id: "forYouReplies", label: t("Show replies in tab"), desc: "Show replies in For You.", type: "bool", def: true, store: "state", key: "forYouReplies", page: "#/customize", cat: "feed", risk: "safe", sync: "account", words: "replies comments for you respuestas ответы जवाब" });
  add({ id: "communitiesHome", label: t("Communities on Home"), desc: "Show posts from your communities on Home.", type: "bool", def: true, store: "state", key: "communitiesHome", page: "#/customize", cat: "feed", risk: "safe", sync: "server", words: "communities home comunidades inicio сообщества главная समुदाय" });
  add({ id: "friendsRail", label: t("Friends panel"), desc: "The friends and online panel on the side and on Home.", type: "bool", def: true, store: "state", key: "friendsRail", page: "#/settings/privacy", cat: "friends", risk: "safe", sync: "account",
    words: "friends panel online rail friends stuff amigos panel en línea друзья панель онлайн दोस्त पैनल ऑनलाइन" });
  add({ id: "peopleLinks", label: t("Merged profiles"), desc: "Profiles of the same person on several networks shown as one.", type: "object", store: "state", key: "peopleLinks", page: "#/customize", cat: "feed", risk: "safe", sync: "account", ai: false, words: "merged profiles same person perfiles unidos объединенные профили" });
  add({ id: "busyPrefs", label: t("Posting volume"), desc: "Limits for very busy accounts in your feed.", type: "object", store: "state", key: "busyPrefs", page: "#/customize", cat: "feed", risk: "safe", sync: "account", ai: false, words: "busy accounts volume too many posts cuentas activas volumen активные аккаунты объем" });
  add({ id: "translateTo", label: t("Translate to"), desc: "Language posts are translated into. ui = the app language.", type: "enum", values: ["ui", "en", "es", "ru", "hi", "fr", "de", "pt", "it"], valueLabels: { ui: t("App language"), en: "English", es: "Español", ru: "Русский", hi: "हिन्दी", fr: "Français", de: "Deutsch", pt: "Português", it: "Italiano" }, def: "ui", store: "state", key: "translateTo", page: "#/settings/languages", cat: "language", risk: "safe", sync: "account", words: "translate to translation language traducir a traducción перевод на язык अनुवाद" });
  add({ id: "translateAuto", label: t("Automatically translate posts"), desc: "Translate posts in other languages without tapping.", type: "bool", def: true, store: "state", key: "translateAuto", page: "#/settings/languages", cat: "language", risk: "safe", sync: "account", words: "auto translate automatically traducir automáticamente автоперевод автоматически ऑटो अनुवाद" });
  add({ id: "translateNever", label: t("Never translate"), desc: "Languages that are never translated.", type: "list", store: "state", key: "translateNever", page: "#/settings/languages", cat: "language", risk: "safe", sync: "account", ai: false, words: "never translate nunca traducir никогда не переводить" });
  add({ id: "lang", label: t("Display language"), desc: "Language of the app itself.", type: "enum", values: ["en", "es", "ru", "hi"], valueLabels: { en: "English", es: "Español", ru: "Русский", hi: "हिन्दी" }, def: "en", store: "lang", key: "lang", page: "#/settings/accessibility/display-language", cat: "language", risk: "safe", sync: "account",
    words: "language interface app language idioma lengua язык интерфейса भाषा", valueWords: { en: "english inglés английск अंग्रेज़ी", es: "spanish español испанск स्पैनिश", ru: "russian ruso русск रूसी", hi: "hindi हिन्दी हिंदी хинди" } });
  add({ id: "historyPauseVideos", label: t("Pause watch history"), desc: "Stop saving the videos you watch in History.", type: "bool", def: false, store: "state", key: "historyPause.videos", page: "#/history", cat: "privacy", risk: "safe", sync: "device", words: "watch history pause videos historial pausa история просмотров пауза इतिहास" });
  add({ id: "historyPauseArticles", label: t("Pause reading history"), desc: "Stop saving the articles you open in History.", type: "bool", def: false, store: "state", key: "historyPause.articles", page: "#/history", cat: "privacy", risk: "safe", sync: "device", words: "reading history articles historial lectura история чтения पढ़ने का इतिहास" });

  /* ---- Notifications ---- */
  add({ id: "notify", label: t("Push notifications"), desc: "Notifications from the app on this device. Turning on asks the browser for permission.", type: "bool", def: false, store: "state", key: "notify", page: "#/settings/notifications", cat: "notifications", risk: "safe", sync: "account",
    words: "notifications push alerts notify sound notificaciones avisos alertas уведомления оповещения пуш सूचनाएँ नोटिफिकेशन" });
  add({ id: "notifNames", label: t("Show names in notifications"), desc: "Show who it is from in notifications.", type: "bool", def: true, store: "notifPrivacy", key: "names", page: "#/settings/notifications", cat: "notifications", risk: "safe", private: false, sync: "account", words: "names in notifications nombres имена नाम" });
  add({ id: "notifPreview", label: t("Show message previews"), desc: "Show the message text in notifications.", type: "bool", def: true, store: "notifPrivacy", key: "preview", page: "#/settings/notifications", cat: "notifications", risk: "safe", private: false, sync: "account", words: "message previews text vista previa mensajes превью сообщений संदेश प्रीव्यू" });
  add({ id: "notifBanner", label: t("Banners"), desc: "Pop-up banners for notifications.", type: "bool", def: true, store: "notifPrivacy", key: "banner", page: "#/settings/notifications", cat: "notifications", risk: "safe", sync: "account", words: "notification banners pop up banners emergentes всплывающие बैनर" });
  add({ id: "notifBadge", label: t("Badge"), desc: "The red dot on the app icon and bell.", type: "bool", def: true, store: "notifPrivacy", key: "badge", page: "#/settings/notifications", cat: "notifications", risk: "safe", sync: "account", words: "badge red dot icon insignia punto значок точка बैज" });
  add({ id: "notifCount", label: t("Unread count"), desc: "Show the number of unread notifications.", type: "bool", def: true, store: "notifPrivacy", key: "count", page: "#/settings/notifications", cat: "notifications", risk: "safe", sync: "account", words: "unread count number contador no leídos счетчик непрочитанных गिनती" });
  ["messages", "mentions", "replies", "quotes", "likes", "reposts", "follows", "notes", "posts"].forEach(function (kind) {
    var L = { messages: t("Messages"), mentions: t("Mentions"), replies: t("Replies"), quotes: t("Quotes"), likes: t("Likes"), reposts: t("Reposts"), follows: t("New followers"), notes: t("Community Notes"), posts: t("New posts") };
    var W = { messages: "messages dm mensajes сообщения संदेश", mentions: "mentions menciones упоминания उल्लेख", replies: "replies respuestas ответы जवाब", quotes: "quotes citas цитаты उद्धरण", likes: "likes me gusta лайки पसंद", reposts: "reposts репосты रीपोस्ट", follows: "followers follows seguidores подписчики फ़ॉलोअर", notes: "community notes notas заметки नोट्स", posts: "new posts publicaciones посты पोस्ट" };
    add({ id: "notifType_" + kind, label: L[kind], desc: "Notifications for " + kind + ".", type: "bool", def: true, store: "notifPrivacy", key: "types." + kind, page: "#/settings/notifications", cat: "notifications", risk: "safe", sync: "account", words: "notifications alerts " + W[kind] });
  });
  add({ id: "bells", label: t("Account alerts"), desc: "Bell alerts for single accounts.", type: "object", store: "state", key: "bells", page: "#/settings/notifications", cat: "notifications", risk: "safe", sync: "account", ai: false, words: "bell account alerts campana алерты колокольчик घंटी" });
  add({ id: "noteTabs", label: t("Notification tabs"), desc: "Your own tabs in Notifications, with their people and alert types.", type: "object", store: "state", key: "noteTabs", page: "#/settings/content", cat: "notifications", risk: "safe", sync: "account", ai: false, words: "notification tabs games tab pestañas notificaciones вкладки уведомлений टैब" });
  add({ id: "noteTabsSame", label: t("Same tabs as Home"), desc: "Notifications use the same custom tabs as Home.", type: "bool", def: true, store: "state", key: "noteTabsSame", page: "#/settings/content", cat: "notifications", risk: "safe", sync: "account", words: "same tabs home notifications mismas pestañas те же вкладки" });
  add({ id: "notePrefs", label: t("Notification filters"), desc: "Filters for the Notifications list.", type: "object", store: "state", key: "notePrefs", page: "#/settings/notifications", cat: "notifications", risk: "safe", sync: "account", ai: false, words: "notification filters filtros фильтры" });

  /* ---- Tabs, lists and groups ---- */
  add({ id: "feedTabs", label: t("Custom tabs"), desc: "Your own tabs on Home.", type: "object", store: "state", key: "feedTabs", page: "#/settings/content", cat: "feed", risk: "safe", sync: "account", ai: false, words: "custom tabs home groups pestañas вкладки टैब" });
  add({ id: "groups", label: t("Groups"), desc: "Account groups used by tabs.", type: "object", store: "state", key: "groups", page: "#/settings/content", cat: "feed", risk: "safe", sync: "account", ai: false, words: "groups grupos группы समूह" });
  add({ id: "groupsOwn", label: t("Use my own groups"), desc: "Use your own groups instead of the default ones.", type: "bool", def: false, store: "state", key: "groupsOwn", page: "#/settings/content", cat: "feed", risk: "safe", sync: "account", ai: false });
  add({ id: "subsGroup", label: t("Subscriptions"), desc: "The group shown in Subscriptions.", type: "text", store: "state", key: "subsGroup", page: "#/subscriptions", cat: "feed", risk: "safe", sync: "account", ai: false });
  add({ id: "tabViews", label: t("Tab views"), desc: "How each tab is shown (list or grid).", type: "object", store: "state", key: "tabViews", page: "#/settings/content", cat: "feed", risk: "safe", sync: "account", ai: false });
  add({ id: "communityTabs", label: t("Community tabs"), desc: "Tabs inside communities.", type: "object", store: "state", key: "communityTabs", page: "#/communities", cat: "feed", risk: "safe", sync: "account", ai: false });
  add({ id: "communityFolders", label: t("Community folders"), desc: "Your folders of communities.", type: "object", store: "state", key: "communityFolders", page: "#/communities", cat: "feed", risk: "safe", sync: "account", ai: false });
  add({ id: "lists", label: t("Lists"), desc: "Your lists of accounts.", type: "object", store: "state", key: "lists", page: "#/lists", cat: "feed", risk: "safe", sync: "account", ai: false, words: "lists listas списки सूचियाँ" });

  /* ---- Privacy and safety ---- */
  add({ id: "protected", label: t("Protect your posts"), desc: "Only approved followers and friends can see your posts and lists. Off = public posts.", type: "bool", def: false, store: "account", key: "protected", page: "#/settings/privacy", cat: "privacy", risk: "privacy", private: true, sync: "server", signedIn: true,
    words: "protect posts private account locked public privada proteger publicaciones cuenta privada защитить посты закрытый аккаунт приватный पोस्ट सुरक्षित निजी खाता" });
  add({ id: "privateFollows", label: t("Private followers and following"), desc: "Only you can see your followers and following lists.", type: "bool", def: false, store: "account", key: "privateFollows", page: "#/settings/privacy", cat: "privacy", risk: "privacy", private: true, sync: "server", signedIn: true,
    words: "private followers following lists seguidores siguiendo privados подписчики подписки скрыть फ़ॉलोअर्स निजी" });
  add({ id: "profileLess", label: t("Profile-less account"), desc: "No public profile. Browse and comment anonymously.", type: "bool", def: false, store: "account", key: "profileLess", page: "#/settings/privacy", cat: "privacy", risk: "privacy", private: true, sync: "server", signedIn: true,
    words: "profile-less anonymous no profile anónimo sin perfil анонимно без профиля गुमनाम" });
  add({ id: "hideAvatar", label: t("Hide my profile picture"), desc: "What other people see instead of your photo: '' = your photo, default = default picture, none = nothing.", type: "enum", values: ["", "default", "none"], valueLabels: { "": t("Show my picture"), "default": t("Default"), none: t("None") }, def: "", store: "account", key: "hideAvatar", page: "#/settings/privacy", cat: "privacy", risk: "privacy", private: "none", sync: "server", signedIn: true,
    words: "hide my profile picture photo ocultar mi foto скрыть мое фото छिपाएँ मेरी तस्वीर" });
  add({ id: "discoverable", label: t("Suggest my account to others"), desc: "Show your account in People you may know.", type: "bool", def: true, store: "pymk", key: "discoverable", page: "#/settings/suggestions", cat: "privacy", risk: "privacy", private: false, sync: "server", signedIn: true,
    words: "suggest me discoverable people you may know find me sugerir descubrible предлагать меня рекомендации सुझाव" });
  add({ id: "searchable", label: t("Let others find me in search"), desc: "Show your account in People search. When off, only the site owner can find it there.", type: "bool", def: true, store: "pymk", key: "searchable", page: "#/settings/privacy", cat: "privacy", risk: "privacy", private: false, sync: "server", signedIn: true,
    words: "find me in search searchable show me in search hide me from search search visibility encontrarme en la búsqueda buscable найти меня в поиске поиск खोज में मुझे ढूँढें" });
  add({ id: "onlineStatus", label: t("Who sees when you're online"), desc: "Who can see your online status.", type: "enum", values: ["everyone", "followers", "mutuals", "follows", "lists", "nobody"], valueLabels: { everyone: t("Everyone"), followers: t("Followers"), mutuals: t("Mutuals"), follows: t("People you follow"), lists: t("Lists"), nobody: t("Nobody") }, def: "everyone", store: "presence", key: "seenPrivacy", page: "#/online", cat: "friends", risk: "privacy", private: "nobody", sync: "server", signedIn: true,
    words: "online status presence last seen active en línea estado visto онлайн статус в сети ऑनलाइन स्थिति", valueWords: { everyone: "everyone all public todos все सब", nobody: "nobody no one hide invisible nadie никто скрыть कोई नहीं", followers: "followers seguidores подписчики फ़ॉलोअर", mutuals: "mutuals friends mutuos amigos взаимные друзья दोस्त" } });
  add({ id: "privacyEmbedShield", label: t("Third-party embed shield"), desc: "Blocks outside players and embeds until you tap them.", type: "bool", def: false, store: "state", key: "privacyEmbedShield", page: "#/settings/privacy", cat: "privacy", risk: "privacy", private: true, sync: "account", words: "embed shield third party trackers escudo incrustados защита встраиваний" });
  add({ id: "privacyWebRTC", label: t("WebRTC leak protection"), desc: "Hides your IP address from peer connections.", type: "bool", def: true, store: "state", key: "privacyWebRTC", page: "#/settings/privacy", cat: "privacy", risk: "privacy", private: true, sync: "account", words: "webrtc ip leak fuga утечка ip" });
  add({ id: "privacyNoReferrer", label: t("Strict no-referrer"), desc: "Sites you open do not learn where you came from.", type: "bool", def: true, store: "state", key: "privacyNoReferrer", page: "#/settings/privacy", cat: "privacy", risk: "privacy", private: true, sync: "account", words: "referrer referer реферер" });
  add({ id: "privacyStripTrackers", label: t("Strip tracking parameters"), desc: "Removes tracking codes from links.", type: "bool", def: true, store: "state", key: "privacyStripTrackers", page: "#/settings/privacy", cat: "privacy", risk: "privacy", private: true, sync: "account", words: "tracking parameters utm trackers rastreo трекеры отслеживание ट्रैकिंग" });
  add({ id: "privacyAntiFingerprint", label: t("Fingerprint resistance"), desc: "Makes this browser harder to fingerprint.", type: "bool", def: true, store: "state", key: "privacyAntiFingerprint", page: "#/settings/privacy", cat: "privacy", risk: "privacy", private: true, sync: "account", words: "fingerprint huella отпечаток браузера फिंगरप्रिंट" });
  add({ id: "privacyZeroTrace", label: t("Zero-trace browsing"), desc: "Leave no history or caches on this device.", type: "bool", def: false, store: "state", key: "privacyZeroTrace", page: "#/settings/privacy", cat: "privacy", risk: "privacy", private: true, sync: "device", words: "zero trace no history incognito sin rastro без следов инкогнито" });
  add({ id: "mutedWords", label: t("Muted words"), desc: "Words you never want to see.", type: "list", store: "state", key: "mutedWords", page: "#/settings/muted", cat: "privacy", risk: "safe", sync: "account", ai: false, words: "muted words mute palabras silenciadas скрытые слова म्यूट शब्द" });
  add({ id: "mutedAccounts", label: t("Muted accounts"), desc: "Accounts you muted.", type: "list", store: "state", key: "mutedAccounts", page: "#/settings/muted", cat: "privacy", risk: "safe", sync: "account", ai: false, words: "muted accounts cuentas silenciadas заглушенные аккаунты" });
  add({ id: "blocks", label: t("Muted & blocked"), desc: "Blocked accounts, posts, sources and types.", type: "object", store: "state", key: "blocks", page: "#/settings/muted", cat: "privacy", risk: "safe", sync: "account", ai: false, words: "blocked block bloquear bloqueados заблокированные блок ब्लॉक" });
  add({ id: "repostOff", label: t("Reposts turned off"), desc: "Accounts whose reposts you hid.", type: "list", store: "state", key: "repostOff", cat: "feed", risk: "safe", sync: "account", ai: false });
  add({ id: "notifPrivacy", label: t("Notification privacy"), desc: "Group of the notification privacy switches above.", type: "data", store: "state", key: "notifPrivacy", page: "#/settings/notifications", cat: "notifications", sync: "account", ai: false });

  /* ---- Device and on-device AI ---- */
  add({ id: "deviceLevel", label: t("Device performance"), desc: "How much this device does itself: low, balanced or max.", type: "enum", values: ["light", "balanced", "max"], valueLabels: { light: t("Light"), balanced: t("Balanced"), max: t("Max") }, def: "balanced", store: "device", key: "level", page: "#/settings/device", cat: "device", risk: "safe", sync: "device", words: "performance battery speed device rendimiento batería производительность батарея प्रदर्शन बैटरी" });
  add({ id: "devicePerf", label: t("Device performance"), desc: "Group of device performance choices.", type: "data", store: "state", key: "devicePerf", page: "#/settings/device", cat: "device", sync: "device", ai: false });

  /* ---- Security and account actions (never done by the assistant) ---- */
  add({ id: "friendsSwitch", label: t("Friends"), desc: "Friends master switch: turn Friends off entirely (no requests, lists, counts or online status), or choose who can send requests and see your friends.", type: "action", store: "module", page: "#/settings/friends", cat: "friends", risk: "privacy", ai: false, signedIn: true, words: "friends off turn off friends friend requests who can send requests friends list desactivar amigos solicitudes de amistad отключить друзей заявки в друзья दोस्त बंद फ्रेंड रिक्वेस्ट" });
  add({ id: "appLock", label: t("App lock"), desc: "Lock the app with a passkey, PIN or fingerprint.", type: "action", store: "module", page: "#/settings/security", cat: "security", risk: "danger", ai: false, words: "app lock pin passkey fingerprint face bloqueo huella блокировка отпечаток लॉक" });
  add({ id: "passkeys", label: t("Passkeys"), desc: "Sign in without a password.", type: "action", store: "module", page: "#/settings/security", cat: "security", risk: "danger", ai: false, words: "passkey password contraseña пароль ключ पासकी" });
  add({ id: "devices", label: t("My devices"), desc: "Every device signed in to this account, and signing them out.", type: "action", store: "module", page: "#/settings/devices", cat: "security", risk: "danger", ai: false, words: "devices sessions sign out dispositivos sesiones устройства сеансы डिवाइस" });
  add({ id: "logout", label: t("Log out"), desc: "Sign out on this device.", type: "action", store: "module", page: "#/settings", cat: "security", risk: "danger", ai: false, words: "log out sign out logout cerrar sesión salir выйти выход लॉग आउट" });
  add({ id: "deleteAccount", label: t("Delete account"), desc: "Delete your account for good.", type: "action", store: "module", page: "#/settings/delete-account", cat: "security", risk: "danger", ai: false, words: "delete account remove eliminar cuenta borrar удалить аккаунт खाता हटाएँ" });
  add({ id: "clearStorage", label: t("Data and storage"), desc: "Clear caches and downloads on this device.", type: "action", store: "module", page: "#/settings/storage", cat: "storage", risk: "danger", ai: false, words: "clear cache storage space delete downloads borrar caché almacenamiento очистить кэш хранилище कैश" });
  add({ id: "usernames", label: t("Usernames"), desc: "Your usernames and who sees which one.", type: "action", store: "module", page: "#/settings/usernames", cat: "privacy", risk: "safe", ai: false, words: "username handle nickname nombre de usuario apodo никнейм имя пользователя उपयोगकर्ता नाम" });
  add({ id: "gamesPrivacy", label: t("Games privacy"), desc: "Who sees your games and who can invite you.", type: "action", store: "module", page: "#/settings/privacy", cat: "games", risk: "safe", ai: false, words: "games invites privacy juegos invitaciones игры приглашения गेम्स" });
  add({ id: "liveTranslate", label: t("Live Translate"), desc: "Live captions and translation for videos and lives.", type: "action", store: "module", page: "#/settings/live-translate", cat: "language", risk: "safe", ai: false, words: "live translate captions subtitles subtítulos traducción en vivo субтитры живой перевод लाइव अनुवाद" });
  add({ id: "keys", label: t("Connected keys"), desc: "Keys from your own accounts, kept encrypted.", type: "action", store: "module", page: "#/settings/keys", cat: "security", risk: "danger", ai: false, words: "api keys tokens connect claves ключи токены कुंजियाँ" });
  add({ id: "nostr", label: t("Nostr"), desc: "Nostr relays and keys.", type: "action", store: "module", page: "#/settings/nostr", cat: "network", risk: "safe", ai: false, words: "nostr relays" });
  add({ id: "xPosting", label: t("Post to X"), desc: "Cross-posting to X.", type: "action", store: "module", page: "#/settings/x-posting", cat: "network", risk: "safe", ai: false, words: "post to x twitter crosspost publicar en x публиковать в x" });
  add({ id: "tvLink", label: t("Link a TV"), desc: "Sign a TV in with the code it shows. TV picture and sound settings live in the TV app.", type: "action", store: "module", page: "#/link-tv", cat: "tv", risk: "safe", ai: false, words: "tv television android tv link pair televisor vincular телевизор привязать टीवी" });
  add({ id: "tempLabel", label: t("Temporary accounts"), desc: "Owner only: show a Temporary label on temporary accounts.", type: "action", store: "module", page: "#/settings", cat: "security", risk: "safe", ai: false });
  add({ id: "runSetup", label: t("Run setup again"), desc: "Go through the first-time setup again.", type: "action", store: "module", page: "#/settings", cat: "look", risk: "safe", ai: false, words: "setup onboarding again configuración inicial настройка заново सेटअप" });

  /* ---- Internal app data (not settings; never edited by the assistant) ---- */
  ["version", "initialized", "follows", "seenFeeds", "seenDefaults", "likes", "bookmarks", "reposts", "savedPosts", "bellNotes", "bellSeen", "bellRead", "bellsAt",
    "lastNoteTab", "noteClearedAt", "noteDismissed", "builtinNoteRead", "historyCut", "accountFollows", "newsletters", "redditVotes",
    "prefsAt", "syncUi", "syncUiAt", "musicPrefs"].forEach(function (key) {
    add({ id: key, label: key, desc: "Internal app data.", type: "data", store: "state", key: key, cat: "data", sync: "account", ai: false });
  });

  /* Plain-word groups that change several settings at once. */
  var MACROS = [
    { id: "makePrivate", label: t("Make my account private"), words: "make it private|make me private|private account|account private|private profile|profile private|go private|lock down|lock it down|max privacy|maximum privacy|hacerla privada|hazla privada|cuenta privada|modo privado|сделай приватным|сделать приватным|приватный аккаунт|аккаунт приватным|закрытый аккаунт|закрой аккаунт|сделай закрытым|аккаунт закрытым|профиль приватный|приватный профиль|закрытый профиль|профиль закрытым|perfil privado|निजी बनाओ|निजी खाता|अकाउंट प्राइवेट|प्राइवेट करो", set: { "protected": true, privateFollows: true, discoverable: false, onlineStatus: "nobody" } },
    { id: "makePublic", label: t("Make my account public"), words: "make it public|make me public|public account|account public|go public|hacerla pública|hazla pública|cuenta pública|сделай публичным|сделать публичным|публичный аккаунт|открой аккаунт|सार्वजनिक बनाओ|सार्वजनिक खाता|पब्लिक करो", set: { "protected": false, privateFollows: false, discoverable: true } },
    { id: "hideFriends", label: t("Hide friends stuff"), words: "hide friends|friends stuff|no friends|friends off|hide the friends|ocultar amigos|oculta amigos|oculta los amigos|sin amigos|cosas de amigos|скрой друзей|скрыть друзей|убери друзей|без друзей|дружеское|दोस्त छिपाओ|दोस्तों को छिपाओ|दोस्त हटाओ", set: { friendsRail: false, onlineStatus: "nobody" } },
    { id: "lessData", label: t("Use less data"), words: "use less data|less data|save data|saving data|cheap data|small data plan|menos datos|ahorra datos|ahorrar datos|меньше трафика|экономь трафик|экономить трафик|сэкономь трафик|कम डेटा|डेटा बचाओ", set: { saveData: true, autoplay: "wifi", videoHd: false, imageSize: "small" } },
    { id: "calm", label: t("Calmer app"), words: "calmer|calm it down|less distracting|more calm|quiet app|focus mode|más tranquila|modo concentración|спокойнее|меньше отвлекает|режим фокуса|शांत करो|कम ध्यान भटके", set: { reduceMotion: true, autoplay: "never", livePreview: "off", homePills: false } }
  ];

  var BY_ID = {};
  LIST.forEach(function (row) { BY_ID[row.id] = row; });

  function get(id) { return BY_ID[id] || null; }
  function all() { return LIST.slice(); }
  /* Rows the assistant may change. */
  function editable() { return LIST.filter(function (row) { return row.ai !== false && row.type !== "data" && row.type !== "action"; }); }
  /* Every key a row covers inside a store, e.g. "state:autoplay". */
  function storeKeys(store) {
    return LIST.filter(function (row) { return row.store === store && row.key; }).map(function (row) { return String(row.key).split(".")[0]; });
  }
  /* Check a value against a row. Returns { ok, value } with the cleaned value. */
  function validate(id, value) {
    var row = BY_ID[id];
    if (!row) return { ok: false, error: "unknown" };
    if (row.ai === false || row.type === "data" || row.type === "action") return { ok: false, error: "readonly" };
    if (row.type === "bool") {
      if (value === true || value === false) return { ok: true, value: value };
      var s = String(value).toLowerCase();
      if (s === "true" || s === "on" || s === "1" || s === "yes") return { ok: true, value: true };
      if (s === "false" || s === "off" || s === "0" || s === "no") return { ok: true, value: false };
      return { ok: false, error: "type" };
    }
    if (row.type === "enum") {
      var v = value == null ? "" : String(value);
      if (row.values.indexOf(v) >= 0) return { ok: true, value: v };
      var lower = v.toLowerCase();
      for (var i = 0; i < row.values.length; i += 1) {
        var lab = row.valueLabels && row.valueLabels[row.values[i]];
        if (String(row.values[i]).toLowerCase() === lower || (lab && String(lab).toLowerCase() === lower)) return { ok: true, value: row.values[i] };
      }
      return { ok: false, error: "value" };
    }
    if (row.type === "number") {
      var n = Number(value);
      if (!isFinite(n)) return { ok: false, error: "type" };
      n = Math.max(row.min, Math.min(row.max, Math.round(n)));
      if (row.values && row.values.indexOf(n) < 0) return { ok: false, error: "value" };
      return { ok: true, value: n };
    }
    return { ok: false, error: "readonly" };
  }
  /* True when the change makes the account or device less private. */
  function lessPrivate(id, from, to) {
    var row = BY_ID[id];
    if (!row || row.risk !== "privacy" || row.private === undefined) return false;
    if (row.type === "bool") return from !== to && to !== row.private;
    if (row.type === "enum") {
      if (id === "onlineStatus") {
        var order = ["nobody", "lists", "mutuals", "follows", "followers", "everyone"];
        return order.indexOf(to) > order.indexOf(from);
      }
      return from === row.private && to !== row.private;
    }
    return false;
  }
  function toJSON() {
    return { version: 1, settings: LIST.map(function (row) {
      var out = {};
      Object.keys(row).forEach(function (k) { if (k !== "words" && k !== "valueWords") out[k] = row[k]; });
      return out;
    }), macros: MACROS.map(function (m) { return { id: m.id, label: m.label, set: m.set }; }) };
  }
  return { LIST: LIST, MACROS: MACROS, get: get, all: all, editable: editable, storeKeys: storeKeys, validate: validate, lessPrivate: lessPrivate, toJSON: toJSON };
});
