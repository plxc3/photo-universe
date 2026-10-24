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

