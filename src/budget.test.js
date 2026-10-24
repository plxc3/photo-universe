import test, {beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadDemoPhotos,loadLocalPhotos,buildPhotoAtlases,getPhotoThumbnail,releasePhotos} from './photos.js';
import {FrameProfiler} from './performance.js';
const editorial=new URL('../public/editorial/',import.meta.url);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1UAAAAASUVORK5CYII=','base64');
const original={document:globalThis.document,createImageBitmap:globalThis.createImageBitmap,fetch:globalThis.fetch};
let canvases,active,maxActive,closed,albums;
beforeEach(()=>{
 canvases=[];active=0;maxActive=0;closed=0;albums=[];
 globalThis.document={createElement:()=>{const canvas={width:0,height:0,getContext:()=>({fillRect(){},drawImage(){}}),toBlob:cb=>cb(new Blob(['thumbnail'],{type:'image/jpeg'}))};canvases.push(canvas);return canvas;}};
 globalThis.createImageBitmap=async(_,options)=>{active++;maxActive=Math.max(active,maxActive);await new Promise(r=>setTimeout(r,0));active--;return{width:options.resizeWidth,height:options.resizeHeight,close(){closed++;}}};
});
afterEach(()=>{
 albums.forEach(releasePhotos);
 for(const[key,value]of Object.entries(original)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});
test('curated demo uses local photos and thumbnails, keeps actual dimensions and credits',async()=>{
 const manifest=JSON.parse(await readFile(new URL('manifest.json',editorial),'utf8'));
 const requested=[];
 globalThis.fetch=async url=>{
  requested.push(String(url));
  const file=String(url).endsWith('manifest.json')?'manifest.json':new URL(String(url)).pathname.split('/editorial/')[1];
  const content=await readFile(new URL(file,editorial));
  return new Response(content,{status:200,headers:{'content-type':file.endsWith('.json')?'application/json':'image/jpeg'}});
 };
 const {photos}=await loadDemoPhotos();
 assert.equal(photos.length,24);
 assert.ok(photos.every(p=>p.source==='demo'&&p.author&&p.sourceUrl&&p.thumbnailUrl.includes('/editorial/thumbs/')));
 const atlases=await buildPhotoAtlases(photos,null,{maxTextureSize:4096});
 assert.equal(atlases.diagnostics.decodedCount,24);
 assert.deepEqual(photos.map(p=>[p.width,p.height]),manifest.map(p=>[p.width,p.height]));
 assert.ok(requested.every(u=>u.includes('/editorial/')));
 assert.ok(requested.slice(1).every(u=>u.includes('/editorial/thumbs/')));
 assert.equal(closed,24);
});
test('3000-photo desktop and low-memory atlases remain within their explicit byte budgets and cover every photo',async()=>{
 for(const options of [{maxTextureSize:2048,maxAtlasBytes:64*1024*1024,mobile:false},{maxTextureSize:1024,maxAtlasBytes:32*1024*1024,mobile:true,deviceMemoryGB:2}]){
  maxActive=0;
  const result=await loadLocalPhotos(Array.from({length:3000},(_,i)=>new File([png],'image-'+i+'.png',{type:'image/png'})));
  albums.push(result.photos);
  const atlases=await buildPhotoAtlases(result.photos,null,options);
  const actual=atlases.reduce((sum,a)=>sum+a.canvas.width*a.canvas.height*4,0);
  assert.ok(actual<=options.maxAtlasBytes);
  assert.equal(actual,atlases.diagnostics.canvasBytes);
  assert.ok(atlases.every(a=>a.canvas.width<=options.maxTextureSize&&a.canvas.height<=options.maxTextureSize));
  assert.deepEqual(atlases.flatMap(a=>a.photoIndices),Array.from({length:3000},(_,i)=>i));
  assert.ok(atlases.diagnostics.maximumConcurrentDecodes<=(options.mobile?1:3));
  assert.ok(maxActive<=(options.mobile?1:3));
  assert.equal(atlases.diagnostics.decodedCount,3000);
 }
 assert.equal(closed,6000);
});
test('small desktop albums use sharper atlas cells without enlarging mobile or low-memory textures',async()=>{
 const {photos}=await loadLocalPhotos(Array.from({length:24},(_,i)=>new File([png],i+'.png',{type:'image/png'})));
 albums.push(photos);
 for(const [options,expected] of [
  [{maxTextureSize:8192,mobile:false,deviceMemoryGB:8},384],
  [{maxTextureSize:4096,mobile:false,deviceMemoryGB:8},256],
  [{maxTextureSize:8192,mobile:true,deviceMemoryGB:8},128],
  [{maxTextureSize:8192,mobile:false,deviceMemoryGB:2},128],
  [{maxTextureSize:8192,mobile:false,maxAtlasBytes:10*1024*1024},256],
 ]){
  const atlases=await buildPhotoAtlases(photos,null,options);
  assert.equal(atlases.diagnostics.cellSize,expected);
  assert.ok(atlases.diagnostics.canvasBytes<=atlases.diagnostics.maxAtlasBytes);
  atlases.forEach(({canvas})=>{canvas.width=0;canvas.height=0;});
 }
});
test('a failed atlas build releases every canvas and closes already-decoded bitmaps',async()=>{
 const {photos}=await loadLocalPhotos(Array.from({length:8},(_,i)=>new File([png],i+'.png',{type:'image/png'})));
 albums.push(photos);
 await assert.rejects(buildPhotoAtlases(photos,({loaded})=>{if(loaded>=3)throw new Error('cancelled');}),/cancelled/);
 assert.ok(canvases.every(c=>c.width===0&&c.height===0));
 assert.equal(closed,3);
});
test('gallery thumbnails reuse atlas cells without decoding originals or owning original URLs',async()=>{
 const {photos}=await loadLocalPhotos([new File([png],'local.png',{type:'image/png'})]);albums.push(photos);
 const originalUrl=photos[0].url;
 const atlases=await buildPhotoAtlases(photos);
 const decodedBefore=closed;
 const thumbnail=await getPhotoThumbnail(photos[0]);
 assert.equal(thumbnail.owned,true);assert.notEqual(thumbnail.url,originalUrl);
 assert.equal(closed,decodedBefore);
 URL.revokeObjectURL(thumbnail.url);
 atlases[0].canvas.width=0;atlases[0].canvas.height=0;
 assert.deepEqual(await getPhotoThumbnail(photos[0]),{url:originalUrl,owned:false});
 const demo={source:'demo',url:'local-original',thumbnailUrl:'local-small'};
 assert.deepEqual(await getPhotoThumbnail(demo),{url:'local-small',owned:false});
});
test('quality gallery thumbnails preserve original aspect, serialize native decodes, and release working pixels',async()=>{
 const {photos}=await loadLocalPhotos(Array.from({length:4},(_,i)=>new File([png],i+'.png',{type:'image/png'})));
 albums.push(photos);
 photos.forEach(p=>{p.width=4000;p.height=2000;});
 const thumbnails=await Promise.all(photos.map(p=>getPhotoThumbnail(p,360,{quality:true})));
 assert.equal(maxActive,1);
 assert.equal(closed,4);
 assert.equal(new Set(thumbnails.map(t=>t.url)).size,4);
 assert.ok(thumbnails.every(t=>t.owned&&!photos.some(p=>p.url===t.url)));
 assert.ok(canvases.every(c=>c.width===0&&c.height===0));
 thumbnails.forEach(t=>URL.revokeObjectURL(t.url));
 let requested;
 globalThis.createImageBitmap=async(_,options)=>{requested=options;return{width:options.resizeWidth,height:options.resizeHeight,close(){closed++;}};};
 const thumbnail=await getPhotoThumbnail(photos[0],360,{quality:true});
 assert.equal(requested.resizeWidth,360);assert.equal(requested.resizeHeight,180);
 assert.equal(requested.resizeQuality,'high');
 URL.revokeObjectURL(thumbnail.url);
});
test('queued and active quality thumbnail cancellations never create an owned URL or leak a bitmap',async()=>{
 const {photos}=await loadLocalPhotos(Array.from({length:3},(_,i)=>new File([png],i+'.png',{type:'image/png'})));
 albums.push(photos);
 let finishDecode,announceStart;
 const started=new Promise(resolve=>{announceStart=resolve;});
 let decodes=0;
 globalThis.createImageBitmap=async(_,options)=>{
  decodes++;announceStart();await new Promise(resolve=>{finishDecode=resolve;});
  return{width:options.resizeWidth,height:options.resizeHeight,close(){closed++;}};
 };
 const activeController=new AbortController();
 const queuedController=new AbortController();
 const originalCreate=URL.createObjectURL;
 let urlCount=0;
 URL.createObjectURL=(...args)=>{urlCount++;return originalCreate(...args);};
 try{
  const running=getPhotoThumbnail(photos[0],360,{quality:true,signal:activeController.signal});
  const runningRejected=assert.rejects(running,{name:'AbortError'});
  await started;
  const queued=getPhotoThumbnail(photos[1],360,{quality:true,signal:queuedController.signal});
  const queuedRejected=assert.rejects(queued,{name:'AbortError'});
  queuedController.abort();
  await queuedRejected;
  assert.equal(decodes,1);
  activeController.abort();finishDecode();await runningRejected;
  assert.equal(decodes,1);assert.equal(closed,1);assert.equal(urlCount,0);
  assert.equal(canvases.length,0);
  const preAborted=new AbortController();preAborted.abort();
  await assert.rejects(getPhotoThumbnail(photos[2],360,{quality:true,signal:preAborted.signal}),{name:'AbortError'});
  assert.equal(decodes,1);
 }finally{URL.createObjectURL=originalCreate;}
});
test('quality thumbnail cancellation during encoding releases canvas and prevents URL creation',async()=>{
 const {photos}=await loadLocalPhotos([new File([png],'photo.png',{type:'image/png'})]);albums.push(photos);
 const controller=new AbortController();
 let encodeComplete,announceEncoding;
 const encoding=new Promise(resolve=>{announceEncoding=resolve;});
 globalThis.document={createElement:()=>{
  const canvas={width:0,height:0,getContext:()=>({drawImage(){}}),toBlob:callback=>{encodeComplete=callback;announceEncoding();}};
  canvases.push(canvas);return canvas;
 }};
 const request=getPhotoThumbnail(photos[0],360,{quality:true,signal:controller.signal});
 const rejected=assert.rejects(request,{name:'AbortError'});
 await encoding;controller.abort();encodeComplete(new Blob(['thumbnail']));await rejected;
 assert.equal(closed,1);assert.ok(canvases.every(c=>c.width===0&&c.height===0));
});
test('quality thumbnail encoding failures and released albums clean up their resources',async()=>{
 const {photos}=await loadLocalPhotos([new File([png],'photo.png',{type:'image/png'})]);albums.push(photos);
 globalThis.document={createElement:()=>{
  const canvas={width:0,height:0,getContext:()=>({drawImage(){}}),toBlob:callback=>callback(null)};
  canvases.push(canvas);return canvas;
 }};
 await assert.rejects(getPhotoThumbnail(photos[0],360,{quality:true}),/缩略图生成失败/);
 assert.equal(closed,1);assert.ok(canvases.every(c=>c.width===0&&c.height===0));
 let finishDecode,announceStart;
 const started=new Promise(resolve=>{announceStart=resolve;});
 globalThis.createImageBitmap=async(_,options)=>{
  announceStart();await new Promise(resolve=>{finishDecode=resolve;});
  return{width:options.resizeWidth,height:options.resizeHeight,close(){closed++;}};
 };
 const pending=getPhotoThumbnail(photos[0],360,{quality:true});
 const rejected=assert.rejects(pending,{name:'AbortError'});
 await started;releasePhotos(photos);finishDecode();await rejected;
 assert.equal(closed,2);assert.equal(canvases.length,1);
});
test('frame timing records dropped frames rather than hiding them behind the scene delta clamp',()=>{
 const profile=new FrameProfiler();profile.start();
 [0,16.7,33.4,50.1,366.8,383.5].forEach(t=>profile.push(t));
 const report=profile.finish();
 assert.ok(report.medianFps>59&&report.medianFps<61);
 assert.equal(report.over250ms,1);assert.equal(report.over50ms,1);
 assert.ok(report.maxFrameMs>316);
 profile.push(9999);assert.equal(profile.frameCount,5);
 profile.start();assert.equal(profile.finish().frames,0);
});

