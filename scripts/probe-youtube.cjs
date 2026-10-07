const { searchYouTube } = require('../lib/youtube-search');
searchYouTube('drake').then(hits => console.log(JSON.stringify(hits.slice(0, 3), null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
