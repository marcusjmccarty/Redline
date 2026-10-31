import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context={};vm.createContext(context);
vm.runInContext(readFileSync(new URL('../public/labels.js',import.meta.url),'utf8'),context);
const {place,estimate,overlaps,slots,crosses,indexLines,projectIndex}=context.RedlineLabels;

const item=(id,x,y,priority)=>({id,x,y,width:estimate(id),height:14,priority});
const dot=({x,y})=>({x:x-4.5,y:y-4.5,w:9,h:9});
function assertClear(items,result,{width,height,obstacles=[]}){
  result.forEach((slot,i)=>{
    if(!slot)return;
    const {box}=slot;
    assert.ok(box.x>=0&&box.y>=0&&box.x+box.w<=width&&box.y+box.h<=height,`${items[i].id} stays in the viewport`);
    for(const obstacle of obstacles)assert.ok(!overlaps(box,obstacle),`${items[i].id} avoids obstacles`);
    items.forEach((other,j)=>{
      if(j===i)return;
      assert.ok(!overlaps(box,dot(other)),`${items[i].id} does not cover ${other.id}`);
      if(result[j])assert.ok(!overlaps(box,result[j].box),`${items[i].id} and ${other.id} do not overlap`);
    });
  });
}

test('an isolated city keeps the original right-above label',()=>{
  const [slot]=place([item('LISBON',400,300,0)],{width:1440,height:900});
  assert.equal(slot.name,'right-above');assert.equal(slot.x,10);assert.equal(slot.y,-12);assert.equal(slot.anchor,'start');
  assert.equal(new Set(slots.map(slot=>slot.name)).size,slots.length);
});

test('two close cities both get non-overlapping placements',()=>{
  const view={width:1440,height:900};
  for(const pair of [[item('VIENNA',785,209,0),item('BUDAPEST',796,215,1)],[item('PUERTO AYORA',398,451,0),item('QUITO',406,451,1)],[item('KUALA LUMPUR',1126,486,0),item('SINGAPORE',1135,495,1)]]){
    const result=place(pair,view);
    assert.ok(result.every(Boolean),`${pair[0].id} and ${pair[1].id} are both labelled`);
    assert.notEqual(result[0].name==='right-above'&&result[1].name==='right-above',true);
    assertClear(pair,result,view);
  }
});

test('a crowded cluster hides lower-priority labels but keeps the active one',()=>{
  const view={width:800,height:600},names=['ROME','NAPLES','FLORENCE','BOLOGNA','VENICE','MILAN','TURIN','GENOA','PISA','SIENA'];
  const items=names.map((name,i)=>item(name,400+(i%4)*7,300+Math.floor(i/4)*6,i));
  items[9].priority=-1;
  const result=place(items,view);
  assert.ok(result[9],'The active stop keeps its label');
  assert.ok(result.some(slot=>slot===null),'Some labels are hidden');
  const hidden=result.map((slot,i)=>slot?null:i).filter(i=>i!==null);
  assert.ok(hidden.every(i=>i!==9));
  assert.ok(result[0],'The first stop in route order is labelled before later ones');
  assertClear(items,result,view);
});

test('labels never leave the viewport and flip away from the edges',()=>{
  const view={width:390,height:640},items=[];
  for(let x=0;x<=390;x+=26)for(let y=0;y<=640;y+=80)items.push(item(`CITY ${items.length}`,x,y,items.length));
  const result=place(items,view);
  assertClear(items,result,view);
  const [right]=place([item('AUCKLAND',380,300,0)],view);
  assert.ok(right.anchor==='end','A city at the right edge is labelled to its left');
  const [top]=place([item('REYKJAVIK',100,8,0)],view);
  assert.ok(top.y>0,'A city at the top edge is labelled below');
  const [none]=place([item('NOWHERE',-50,-50,0)],view);
  assert.equal(none,null);
});

test('obstacles such as the route dock are avoided',()=>{
  const view={width:1000,height:700},dock={x:200,y:560,w:600,h:120};
  const items=[item('CAPE TOWN',500,550,0),item('DURBAN',300,700-150,1)];
  const result=place(items,{...view,obstacles:[dock]});
  assert.ok(result.every(Boolean));assert.ok(result.every(slot=>slot.y<0),'Labels sit above the dock');
  assertClear(items,result,{...view,obstacles:[dock]});
});

test('the previous candidate is kept while it is still valid',()=>{
  const view={width:1440,height:900},items=[item('VIENNA',785,209,0),item('BRATISLAVA',797,209,1)];
  const first=place(items,view);
  assertClear(items,first,view);
  // The camera moves the cities apart: each label keeps its slot even though right-above is free again.
  const apart=[item('VIENNA',700,209,0),item('BRATISLAVA',900,209,1)];
  const previous=new Map(first.map((slot,i)=>[items[i].id,slot.name]));
  const kept=place(apart,{...view,previous});
  assert.deepEqual(kept.map(slot=>slot.name),first.map(slot=>slot.name));
  assert.ok(first.some(slot=>slot.name!=='right-above'),'The pair needed a non-default slot');
  assert.deepEqual(place(apart,view).map(slot=>slot.name),['right-above','right-above'],'Without history both use the default');
  // Plain objects work too, and a previous slot that is no longer free is abandoned.
  const blocked=place([item('VIENNA',785,209,0)],{...view,previous:{VIENNA:'left-above'},obstacles:[{x:700,y:180,w:80,h:40}]});
  assert.notEqual(blocked[0].name,'left-above');
  assert.equal(place([item('VIENNA',785,209,0)],{...view,previous:{VIENNA:'below'}})[0].name,'below');
});


test('Puerto Ayora and Quito stay on the outside of their dots, including with stale placement history',()=>{
  for(const [a,b] of [[344,390],[398,406]]){
    const items=[item('PUERTO AYORA',a,450,0),item('QUITO',b,448,1)];
    const result=place(items,{width:1440,height:900,previous:{'PUERTO AYORA':'right-above',QUITO:'right-below'}});
    assert.equal(result[0].anchor,'end');assert.equal(result[1].anchor,'start');
    assertClear(items,result,{width:1440,height:900});
    assert.ok(result[0].box.x+result[0].box.w<items[0].x,'Puerto Ayora is labelled to its own west');
    assert.ok(result[1].box.x>items[1].x,'Quito is labelled to its own east');
  }
});

test('route clearance follows the line itself, including tangencies and offscreen segments',()=>{
  const rect={x:40,y:70,w:10,h:10},diagonal=[[0,0],[100,100]];
  assert.equal(crosses(diagonal,rect),false,'A large route bounding box must not hide unrelated labels');
  assert.equal(crosses([[0,70],[100,70]],rect),true);
  assert.equal(crosses([[0,65],[100,65]],rect,5),true);
  assert.equal(crosses([[-100,75],[1000,75]],rect),true);
  const segments=Array.from({length:120},(_,i)=>[[Math.sin(i)*1300,Math.cos(i)*900],[Math.sin(i+.2)*1300,Math.cos(i+.2)*900]]);
  const indexed=indexLines(segments,{width:800,height:600});
  for(let x=4;x<700;x+=31)for(let y=4;y<560;y+=47){
    const box={x,y,w:78,h:20};assert.equal(indexed.hits(box,5),segments.some(segment=>crosses(segment,box,5)),'Spatial indexing retains exact intersections');
  }
});

test('nearby city labels clear route strokes and retain their positions as a camera moves',()=>{
  const view={width:1000,height:700},items=[item('PUERTO AYORA',420,350,0),item('QUITO',443,345,1),item('LIMA',453,390,2)];
  const segments=[[[420,350],[443,345]],[[443,345],[620,170]],[[443,345],[453,390]],[[400,330],[570,330]]];
  const result=place(items,{...view,segments});assert.ok(result.every(Boolean));assertClear(items,result,view);
  result.forEach(slot=>assert.ok(segments.every(segment=>!crosses(segment,slot.box,5)),'Names have breathing room around the red line'));
  const moved=items.map(city=>({...city,x:city.x+2,y:city.y+1})),lines=segments.map(segment=>segment.map(([x,y])=>[x+2,y+1]));
  const previous=new Map(result.map((slot,i)=>[items[i].id,slot.name]));
  assert.deepEqual(place(moved,{...view,segments:lines,previous}).map(slot=>slot?.name),result.map(slot=>slot.name));
});


test('a cached map-coordinate route index matches screen-space clearance at every zoom',()=>{
  const segments=Array.from({length:80},(_,i)=>[[100+i*13,120+Math.sin(i/7)*100],[113+i*13,120+Math.sin((i+1)/7)*100]]);
  const indexed=indexLines(segments,{width:1440,height:720}),bounds={left:14,top:22};
  for(const zoom of [1,1.5,3,7,13]){
    const matrix={a:zoom,d:zoom*1.3,e:14-200*(zoom-1),f:22-100*(zoom-1)},projected=projectIndex(indexed,matrix,bounds);
    const screen=segments.map(segment=>segment.map(([x,y])=>[x*matrix.a+matrix.e-bounds.left,y*matrix.d+matrix.f-bounds.top]));
    for(let x=10;x<1000;x+=37)for(let y=10;y<600;y+=43){const box={x,y,w:82,h:20};assert.equal(projected.hits(box,5),screen.some(segment=>crosses(segment,box,5)));}
  }
});
