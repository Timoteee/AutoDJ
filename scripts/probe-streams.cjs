(async () => {
  const json = async url => { const r = await fetch(url, { signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
  const tracks = await json('https://api.audius.co/v1/tracks/search?query=drake&limit=20&app_name=AutoDJ');
  const t = tracks.data.find(t => t.duration > 0 && t.duration <= 600 && !t.is_stream_gated && !t.is_unlisted && !t.is_delete);
  console.log('Audius track', JSON.stringify({id:t?.id,track_id:t?.track_id,title:t?.title,duration:t?.duration,user:t?.user?.name,is_streamable:t?.is_streamable}));
  for (const url of [`https://api.audius.co/v1/tracks/${t?.id || t?.track_id}/stream?app_name=AutoDJ`, 'https://invidious.f5.si/api/v1/videos/cimoNqiulUE']) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: {Range:'bytes=0-1023'} });
      console.log(new URL(url).host,r.status,r.headers.get('content-type'));
      if (r.headers.get('content-type')?.includes('json')) { const d = await r.json(); const a = d.adaptiveFormats?.find(f=>f.type?.startsWith('audio/')); console.log('audio format',!!a); if(a){const s=await fetch(a.url,{signal:AbortSignal.timeout(10000),headers:{Range:'bytes=0-1023'}}); console.log('Invidious audio',s.status,s.headers.get('content-type')); await s.body?.cancel();} }
      else await r.body?.cancel();
    } catch(e) { console.log(e.message); }
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
