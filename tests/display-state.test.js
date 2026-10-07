const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('display.html','utf8');

test('unchanged RSS headlines do not rebuild or reshuffle the ticker',()=>{
  const start=html.indexOf('function buildMarquee('),end=html.indexOf('\nbuildMarquee([',start);
  let writes=0, markup='';
  const track={style:{},set innerHTML(value){writes++;markup=value;}};
  const context={state:{config:{marqueeMode:'rss'}},rssItems:['Local A','Local B','Local C','Local D','Local E','Local F'],
    builtMessages:[],document:{getElementById:()=>track},JSON,Math,escapeHtml:s=>s};
  vm.runInNewContext(html.slice(start,end),context);
  for(let i=0;i<100;i++)context.buildMarquee(['Welcome']);
  expect(writes).toBe(1);
  expect(markup.indexOf('Local A')).toBeLessThan(markup.indexOf('Local B'));
  context.rssItems=['New local headline'];context.buildMarquee([]);
  expect(writes).toBe(2);
});

test('a delayed poll cannot overwrite a newer live song',async()=>{
  const start=html.indexOf('async function refreshDisplayState()'),end=html.indexOf('\nsetInterval(async',start);
  let finish, applied=[];
  const context={stateUpdateRevision:1,fetch:()=>new Promise(resolve=>{finish=resolve;}),applyState:d=>applied.push(d)};
  vm.runInNewContext(html.slice(start,end),context);
  const pending=context.refreshDisplayState();context.stateUpdateRevision++;
  finish({json:async()=>({nowPlaying:{title:'Old song'}})});await pending;
  expect(applied).toEqual([]);
  const current=context.refreshDisplayState();finish({json:async()=>({nowPlaying:{title:'Current song'}})});await current;
  expect(applied[0].nowPlaying.title).toBe('Current song');
});

test('the display clock uses the viewer timezone rather than Docker timezone',()=>{
  const start=html.indexOf('function updateClock()'),end=html.indexOf('\nsetInterval(updateClock',start);
  const options=[];
  class Clock {toLocaleTimeString(locale,value){options.push(value);return 'time';}toLocaleDateString(locale,value){options.push(value);return 'date';}}
  const context={Date:Clock,window:{DJ:{config:{timezone:'UTC'}}},document:{getElementById:()=>({})}};
  vm.runInNewContext(html.slice(start,end),context);context.updateClock();
  expect(options.every(value=>!Object.hasOwn(value,'timeZone'))).toBe(true);
});
