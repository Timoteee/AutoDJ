const fs = require('node:fs');
const vm = require('node:vm');

function meter() {
  const html = fs.readFileSync('display.html','utf8');
  const start = html.indexOf('let vuAnimId =');
  const end = html.indexOf('\nanimateVUMeter();',start);
  const bars = Array.from({length:24},()=>({style:{},classList:{toggle(){},remove(){}}}));
  const context = { state:{isPlaying:true,visualizer:{bands:Array(6).fill(.8)}}, visualBands:Array(6).fill(0),
    visualSignalAt:Date.now(), smoothedBass:0,bassBaseline:0, reducedMotion:{matches:false},Date,Math,performance,
    document:{hidden:false,getElementById:id=>id==='vu-container'?{children:bars}:{style:{setProperty(){}}}},
    requestAnimationFrame:()=>1 };
  vm.runInNewContext(html.slice(start,end),context);
  return {context,bars};
}

test('display smoothing follows elapsed time at both 60 and 120 Hz',()=>{
  const a=meter(), b=meter();
  a.context.animateVUMeter(100); b.context.animateVUMeter(100);
  for(let t=1;t<=60;t++) a.context.animateVUMeter(100+t*1000/60);
  for(let t=1;t<=120;t++) b.context.animateVUMeter(100+t*1000/120);
  expect(a.context.visualBands[0]).toBeCloseTo(b.context.visualBands[0],8);
  expect(a.context.visualBands[0]).toBeGreaterThan(.79);
  const height=parseFloat(a.bars[0].style.height);
  a.context.state.isPlaying=false;
  a.context.animateVUMeter(1117);
  expect(parseFloat(a.bars[0].style.height)).toBeLessThan(height);
  expect(parseFloat(a.bars[0].style.height)).toBeGreaterThan(20);
  for(let t=1;t<=120;t++) a.context.animateVUMeter(1117+t*1000/60);
  expect(parseFloat(a.bars[0].style.height)).toBeLessThan(2.01);
});

test('audio frames cannot reset track timing or send full metadata',()=>{
  const source=fs.readFileSync('server.js','utf8');
  const start=source.indexOf("app.post('/api/visualizer'");
  const end=source.indexOf("app.post('/api/nowplaying/update'",start);
  let handler, event, status=200;
  const state={nowPlaying:{title:'Test',elapsed:42}};
  vm.runInNewContext(source.slice(start,end),{app:{post:(path,fn)=>{handler=fn;}},sharedState:state,
    broadcastEvent:(...args)=>{event=args;},Math,Number,Array});
  const response={status:n=>{status=n;return response;},json(){}};
  handler({body:{bands:[.2,.3,.4,.5,2,-1]}},response);
  expect(event[0]).toBe('visualizer');
  expect(state.visualizer.bands).toEqual([.2,.3,.4,.5,1,0]);
  expect(state.nowPlaying.elapsed).toBe(42);
  handler({body:{bands:[NaN]}},response);
  expect(status).toBe(400);
});
