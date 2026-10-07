const targets = [
  ['audius', 'https://api.audius.co/v1/tracks/search?query=drake&limit=3&app_name=AutoDJ'],
  ['archive', 'https://archive.org/advancedsearch.php?q=collection%3Anetlabels%20AND%20mediatype%3Aaudio%20AND%20ambient&output=json&rows=2&fl%5B%5D=identifier&fl%5B%5D=title'],
  ...['invidious.nerdvpn.de', 'yt.chocolatemoo53.com', 'invidious.tiekoetter.com', 'invidious.f5.si'].map(host => [host, `https://${host}/api/v1/search?q=drake&type=video`]),
];
Promise.all(targets.map(async ([name, url]) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
    const text = await r.text();
    console.log(name, r.status, text.slice(0, 600));
  } catch (e) { console.log(name, e.cause?.code || e.message); }
}));
