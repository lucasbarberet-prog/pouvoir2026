/* Réglages de Pouvoir 2026 (version web avec IA gratuite).
   aiMode     : 'local'  = IA installée dans l'appareil (gratuite, hors ligne après le 1er téléchargement).
                'server' = passer par un serveur IA (server/worker.js).
   localModel : modèle installé. Par défaut : 0,5B sur téléphone (≈ 0,4 Go), 1,5B sur ordinateur (≈ 1 Go). */
(function () {
  const mobile = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
  window.POUVOIR_CONFIG = {
    aiMode: 'local',
    localModel: mobile ? 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC' : 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    apiUrl: '',
    appToken: ''
  };
})();
