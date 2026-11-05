/* Draws Redline's hand-lettered typeface from pen strokes and writes it as a WOFF font. Authoring step: node scripts/build-lettering.mjs [bold]
   Every glyph is a list of skeleton strokes. A simulated broad nib gives them thick and thin, serifs are small pen ticks,
   and a slow per-glyph wobble keeps it from looking machine-made. Only Node built-ins are used. */
import fs from 'node:fs';
import {deflateSync} from 'node:zlib';

const BOLD=process.argv[2]==='bold',NIB=20*Math.PI/180,THICK=BOLD?128:92,THIN=BOLD?52:27;
// [path, ends, weight]: ends is two characters for the start and end of the stroke: s serif, l left tick, r right tick, - plain.
const G={
  A:[660,['M40 0L330 716','s-'],['M330 716L622 0','-s'],['M150 232L512 232']],
  B:[600,['M92 0L92 700','ss'],['M92 700L300 700C442 700 486 628 486 540C486 450 424 382 300 376L92 376'],['M300 376C452 376 536 300 536 194C536 80 444 0 300 0L92 0']],
  C:[640,['M582 556C532 660 442 716 340 716C168 716 50 570 50 350C50 130 168 -16 340 -16C450 -16 540 40 592 142'],['M584 704L584 524','--',.5]],
  D:[700,['M92 0L92 700','ss'],['M92 700L284 700C504 700 640 560 640 350C640 140 504 0 284 0L92 0']],
  E:[550,['M92 0L92 700','ss'],['M92 700L490 700'],['M490 704L500 586','--',.5],['M92 366L396 366'],['M398 424L398 308','--',.5],['M92 0L512 0'],['M512 -4L526 132','--',.5]],
  F:[520,['M92 0L92 700','ss'],['M92 700L480 700'],['M480 704L490 586','--',.5],['M92 356L380 356'],['M382 414L382 298','--',.5]],
  G:[690,['M582 556C532 660 442 716 340 716C168 716 50 570 50 350C50 130 168 -16 340 -16C442 -16 532 18 592 70L592 292','-s'],['M584 704L584 524','--',.5]],
  H:[720,['M92 0L92 700','ss'],['M628 0L628 700','ss'],['M92 362L628 362']],
  I:[300,['M150 0L150 700','ss']],
  J:[380,['M300 700L300 90C300 -14 232 -62 140 -62C90 -62 52 -42 30 -8','s-']],
  K:[640,['M92 0L92 700','ss'],['M490 700L104 300','s-'],['M236 436L560 0','-s']],
  L:[520,['M92 0L92 700','ss'],['M92 0L480 0'],['M480 -4L494 130','--',.5]],
  M:[860,['M70 0L114 700','s-',.52],['M114 700L430 34'],['M430 34L742 700','--',.52],['M742 700L792 0','-s']],
  N:[730,['M84 0L84 700','s-',.5],['M84 700L646 -6'],['M646 -6L646 700','-s',.5]],
  O:[730,['M366 716C170 716 50 570 50 350C50 130 170 -16 366 -16C562 -16 682 130 682 350C682 570 562 716 366 716']],
  P:[560,['M92 0L92 700','ss'],['M92 700L300 700C452 700 524 620 524 510C524 400 452 320 300 320L92 320']],
  Q:[730,['M366 716C170 716 50 570 50 350C50 130 170 -16 366 -16C562 -16 682 130 682 350C682 570 562 716 366 716'],['M344 122C430 60 478 -84 650 -124']],
  R:[620,['M92 0L92 700','ss'],['M92 700L300 700C452 700 524 620 524 510C524 400 452 320 300 320L92 320'],['M300 320C362 300 402 222 432 132C452 62 484 0 590 0']],
  S:[540,['M472 578C432 670 362 716 280 716C170 716 90 650 90 550C90 450 170 410 280 360C402 310 492 260 492 150C492 40 402 -16 280 -16C190 -16 110 30 70 132'],['M474 704L474 556','--',.5],['M70 152L70 -12','--',.5]],
  T:[610,['M306 0L306 700','s-'],['M36 700L576 700'],['M36 704L28 586','--',.5],['M576 704L584 586','--',.5]],
  U:[680,['M92 700L92 234C92 70 186 -16 330 -16C474 -16 576 70 576 234L576 700','ss']],
  V:[640,['M40 700L322 -12','s-'],['M322 -12L602 700','-s',.55]],
  W:[900,['M30 700L242 -12','s-'],['M242 -12L450 622','--',.55],['M450 622L662 -12'],['M662 -12L870 700','-s',.55]],
  X:[610,['M58 700L548 0','ss'],['M540 700L70 0','ss',.6]],
  Y:[600,['M40 700L300 340','s-'],['M562 700L300 340','s-',.55],['M300 340L300 0','-s']],
  Z:[570,['M64 700L504 700'],['M504 700L52 0'],['M52 0L516 0'],['M64 704L56 590','--',.5],['M516 -4L526 128','--',.5]],
  a:[490,['M112 362C150 420 210 442 262 442C342 442 392 400 392 320L392 72C392 20 412 -2 462 14'],['M392 262C230 242 90 212 90 110C90 30 150 -10 222 -10C290 -10 352 30 392 92']],
  b:[510,['M90 720L90 0','l-'],['M90 340C140 410 200 442 262 442C382 442 452 340 452 216C452 90 372 -10 252 -10C190 -10 130 20 90 72']],
  c:[440,['M412 352C380 410 322 442 260 442C140 442 50 340 50 216C50 90 140 -10 260 -10C330 -10 390 30 422 92']],
  d:[510,['M402 720L402 72C402 20 420 -2 464 14','l-'],['M402 340C360 410 300 442 240 442C120 442 50 340 50 216C50 90 130 -10 240 -10C300 -10 360 20 402 72']],
  e:[460,['M60 240L402 240C402 362 332 442 240 442C130 442 50 340 50 216C50 90 130 -10 252 -10C322 -10 382 20 422 82']],
  f:[310,['M312 692C282 720 242 732 212 732C140 732 120 680 120 610L120 0','-s'],['M36 430L270 430']],
  g:[490,['M240 442C130 442 70 372 70 290C70 210 130 140 240 140C350 140 412 210 412 290C412 372 350 442 240 442'],['M382 402C410 432 442 442 482 430','--',.6],['M130 166C88 130 90 80 150 70L320 50C422 40 452 -20 452 -70C452 -150 362 -210 240 -210C120 -210 50 -160 50 -100C50 -50 90 -20 150 -6']],
  h:[520,['M90 720L90 0','ls'],['M90 330C140 410 200 442 262 442C352 442 402 390 402 300L402 0','-s']],
  i:[240,['M112 430L112 0','ls'],['M110 610L114 586','--',1.5]],
  j:[240,['M150 430L150 -90C150 -172 100 -212 28 -200','l-'],['M148 610L152 586','--',1.5]],
  k:[500,['M90 720L90 0','ls'],['M362 430L100 190','s-',.7],['M190 272L420 0','-s']],
  l:[240,['M112 720L112 0','ls']],
  m:[760,['M80 430L80 0','ls'],['M80 340C120 410 170 442 222 442C302 442 342 390 342 310L342 0','-s'],['M342 340C382 410 432 442 482 442C562 442 602 390 602 310L602 0','-s']],
  n:[520,['M90 430L90 0','ls'],['M90 330C140 410 200 442 262 442C352 442 402 390 402 300L402 0','-s']],
  o:[500,['M250 442C130 442 50 340 50 216C50 90 130 -10 250 -10C370 -10 450 90 450 216C450 340 370 442 250 442']],
  p:[510,['M90 430L90 -210','ls'],['M90 340C140 410 200 442 262 442C382 442 452 340 452 216C452 90 372 -10 252 -10C190 -10 130 20 90 72']],
  q:[510,['M402 430L402 -210','-s'],['M402 340C360 410 300 442 240 442C120 442 50 340 50 216C50 90 130 -10 240 -10C300 -10 360 20 402 72']],
  r:[360,['M90 430L90 0','ls'],['M90 322C130 400 190 442 262 442C302 442 322 420 332 394']],
  s:[420,['M352 370C322 420 272 442 215 442C140 442 80 400 80 335C80 270 140 245 215 215C302 185 372 160 372 90C372 20 302 -10 215 -10C150 -10 90 20 60 86']],
  t:[330,['M130 592L130 90C130 20 170 -10 222 -10C262 -10 302 10 322 42'],['M36 430L292 430']],
  u:[520,['M90 430L90 132C90 40 140 -10 222 -10C292 -10 352 30 392 102','l-'],['M392 430L392 72C392 20 412 -2 462 14','l-']],
  v:[460,['M40 430L230 -6','s-'],['M230 -6L422 430','-s',.55]],
  w:[640,['M30 430L172 -6','s-'],['M172 -6L312 342','--',.55],['M312 342L452 -6'],['M452 -6L594 430','-s',.55]],
  x:[450,['M60 430L384 0','ss'],['M382 430L62 0','ss',.6]],
  y:[460,['M40 430L232 0','s-'],['M422 430L182 -130C152 -190 110 -212 60 -200','s-',.55]],
  z:[430,['M60 430L372 430'],['M372 430L50 0'],['M50 0L382 0']],
  0:[560,['M280 640C140 640 60 500 60 310C60 120 140 -12 280 -12C420 -12 500 120 500 310C500 500 420 640 280 640']],
  1:[380,['M200 0L200 640','s-'],['M200 640C160 590 110 556 60 540','--',.6]],
  2:[510,['M70 480C90 580 170 640 260 640C370 640 440 570 440 470C440 330 240 200 60 0L460 0'],['M460 -4L470 110','--',.5]],
  3:[500,['M80 530C110 600 180 640 250 640C350 640 420 580 420 490C420 400 350 346 240 340C370 340 450 280 450 180C450 70 360 -12 240 -12C150 -12 80 30 50 110']],
  4:[530,['M380 0L380 640','s-'],['M380 640L40 190L490 190']],
  5:[500,['M420 630L120 630L100 350C150 390 210 410 270 410C380 410 450 330 450 210C450 80 360 -12 240 -12C160 -12 90 20 50 90']],
  6:[520,['M400 610C360 630 320 640 280 640C150 640 70 500 70 300C70 110 150 -12 280 -12C390 -12 460 70 460 180C460 290 390 370 280 370C190 370 110 310 76 220']],
  7:[480,['M50 630L440 630'],['M440 630L180 0','-s'],['M50 634L42 520','--',.5]],
  8:[520,['M260 640C160 640 90 590 90 490C90 400 170 350 260 320C370 280 450 240 450 150C450 50 370 -12 260 -12C150 -12 70 50 70 150C70 240 150 280 260 320C350 350 430 400 430 490C430 590 360 640 260 640']],
  9:[520,['M120 20C160 0 200 -12 240 -12C370 -12 450 130 450 330C450 520 370 640 240 640C130 640 60 560 60 450C60 340 130 260 240 260C330 260 410 320 444 410']],
  '.':[190,['M94 22L98 -4','--',1.5]],',':[190,['M100 30C104 -10 90 -60 50 -100','--',1.05]],
  ':':[190,['M94 22L98 -4','--',1.5],['M94 340L98 314','--',1.5]],';':[190,['M100 30C104 -10 90 -60 50 -100','--',1.05],['M94 340L98 314','--',1.5]],
  '-':[320,['M50 240L270 240','--',1.5]],'–':[480,['M40 240L440 240','--',1.5]],'—':[800,['M40 240L760 240','--',1.5]],
  "'":[170,['M90 720C94 680 84 640 60 610','--',1.05]],'’':[170,['M90 720C94 680 84 640 60 610','--',1.05]],'‘':[170,['M70 610C66 650 76 690 100 720','--',1.05]],
  '"':[280,['M90 720C94 680 84 640 60 610','--',1.05],['M210 720C214 680 204 640 180 610','--',1.05]],'“':[280,['M70 610C66 650 76 690 100 720','--',1.05],['M190 610C186 650 196 690 220 720','--',1.05]],'”':[280,['M90 720C94 680 84 640 60 610','--',1.05],['M210 720C214 680 204 640 180 610','--',1.05]],
  '!':[220,['M110 716L110 170'],['M108 22L112 -4','--',1.5]],'?':[420,['M70 580C100 660 170 716 240 716C330 716 380 650 380 570C380 450 220 400 210 170'],['M208 22L212 -4','--',1.5]],
  '(':[290,['M240 740C110 620 70 480 70 300C70 120 110 -20 240 -140','--',.7]],')':[290,['M50 740C180 620 220 480 220 300C220 120 180 -20 50 -140','--',.7]],
  '/':[360,['M320 730L40 -60','--',.55]],'&':[720,['M640 0L210 500C160 560 170 716 300 716C390 716 430 650 430 590C430 500 330 450 230 390C130 330 60 270 60 170C60 60 150 -16 270 -16C420 -16 540 90 620 300L670 300']],
  '·':[190,['M94 262L98 238','--',1.5]],'•':[240,['M118 262L122 238','--',2.4]],'°':[280,['M140 720C90 720 60 680 60 640C60 600 90 560 140 560C190 560 220 600 220 640C220 680 190 720 140 720','--',.5]],
  '+':[480,['M240 90L240 390'],['M90 240L390 240']],'→':[780,['M50 240L720 240','--',.7],['M560 340L720 240L560 140','--',.7]],'←':[780,['M730 240L60 240','--',.7],['M220 340L60 240L220 140','--',.7]],
  '#':[520,['M190 620L150 60','--',.55],['M360 620L320 60','--',.55],['M90 420L450 420','--',.7],['M70 250L430 250','--',.7]],'%':[640,['M520 660L120 -20','--',.55],['M170 660C110 660 80 610 80 550C80 490 110 440 170 440C230 440 260 490 260 550C260 610 230 660 170 660','--',.55],['M470 220C410 220 380 170 380 110C380 50 410 0 470 0C530 0 560 50 560 110C560 170 530 220 470 220','--',.55]],
  '…':[520,['M90 22L94 -4','--',1.5],['M256 22L260 -4','--',1.5],['M422 22L426 -4','--',1.5]],'×':[440,['M90 370L350 110','--',.7],['M350 370L90 110','--',.7]],'−':[480,['M70 240L410 240','--',1.5]],
};
const MARKS={
  '́':['M60 0L170 120'],'̀':['M170 0L60 120'],'̂':['M30 0L120 110L210 0'],'̃':['M20 40C60 110 90 110 130 70C170 30 200 30 230 100'],
  '̈':['M60 40L64 16',,'M180 40L184 16'],'̊':['M120 130C80 130 60 100 60 70C60 40 80 10 120 10C160 10 180 40 180 70C180 100 160 130 120 130'],
  '̌':['M30 110L120 0L210 110'],'̄':['M40 50L200 50'],'̆':['M40 110C60 30 180 30 200 110'],'̇':['M120 40L124 16'],'̋':['M50 0L120 110',,'M140 0L210 110'],
};
const SPECIAL={ß:'ss',æ:'ae',Æ:'AE',œ:'oe',Œ:'OE',ı:'i',Ø:'O',ø:'o',Ł:'L',ł:'l',Đ:'D',đ:'d',ð:'d',Ð:'D',þ:'p',Þ:'P',ħ:'h',Ħ:'H'};
const KERN={AV:-70,AW:-60,AY:-70,AT:-50,AC:-16,AG:-16,AO:-16,AQ:-16,AU:-16,FA:-50,'F,':-90,'F.':-90,LT:-60,LV:-60,LW:-50,LY:-60,PA:-60,'P,':-100,'P.':-100,RT:-12,RV:-22,RW:-20,RY:-24,TA:-60,TO:-16,'T,':-80,'T.':-80,Ta:-60,Te:-60,To:-60,Tr:-40,Tu:-40,Ty:-40,VA:-70,VO:-16,'V,':-70,'V.':-70,Va:-40,Ve:-40,Vo:-40,WA:-60,'W,':-60,'W.':-60,Wa:-30,We:-30,Wo:-30,YA:-70,YO:-16,'Y,':-70,'Y.':-70,Ya:-46,Ye:-46,Yo:-46,OA:-16,OV:-16,OY:-16,DA:-16,DY:-16,KO:-20,'r,':-40,'r.':-40,'y,':-40,'y.':-40,'v,':-40,'v.':-40,'w,':-30,'w.':-30,ST:-8,LO:-14,oy:-6,ov:-6};

// ---------- From skeleton to outline ----------
function sample(d){
  const tokens=d.match(/[MLQC]|-?\d+(?:\.\d+)?/g),points=[];let i=0,x=0,y=0,command='M';
  const num=()=>Number(tokens[i++]);
  while(i<tokens.length){
    if(/[MLQC]/.test(tokens[i]))command=tokens[i++];
    if(command==='M'){x=num();y=num();points.push([x,y]);command='L';}
    else if(command==='L'){const nx=num(),ny=num(),n=Math.max(2,Math.ceil(Math.hypot(nx-x,ny-y)/38));for(let k=1;k<=n;k++)points.push([x+(nx-x)*k/n,y+(ny-y)*k/n]);x=nx;y=ny;}
    else if(command==='C'){
      const a=num(),b=num(),c=num(),e=num(),f=num(),g=num(),n=Math.max(6,Math.ceil((Math.hypot(a-x,b-y)+Math.hypot(c-a,e-b)+Math.hypot(f-c,g-e))/26));
      for(let k=1;k<=n;k++){const t=k/n,m=1-t;points.push([m*m*m*x+3*m*m*t*a+3*m*t*t*c+t*t*t*f,m*m*m*y+3*m*m*t*b+3*m*t*t*e+t*t*t*g]);}
      x=f;y=g;
    }else throw Error(`Unsupported ${command}`);
  }
  return points;
}
let seedCounter=1;
const rng=seed=>()=>{seed=Math.imul(seed^seed>>>15,seed|1)+0x6d2b79f5|0;let t=Math.imul(seed^seed>>>7,seed|61)^seed;t=t+Math.imul(t^t>>>14,t|61)^t;return ((t^t>>>14)>>>0)/4294967296;};
function wobble(random,amount){
  const a=random()*6.28,b=random()*6.28,c=random()*6.28,d=random()*6.28,f1=.005+random()*.004,f2=.007+random()*.004;
  return ([x,y])=>[x+Math.sin(y*f1+a)*amount+Math.sin(x*f2+b)*amount*.35,y+Math.sin(x*f2+c)*amount+Math.sin(y*f1+d)*amount*.35];
}
function ribbon(points,weight,random){
  const n=points.length,left=[],right=[];
  const closed=Math.hypot(points[0][0]-points[n-1][0],points[0][1]-points[n-1][1])<2;
  const breath=random()*6.28;
  for(let i=0;i<n;i++){
    const prev=closed&&i===0?points[n-2]:points[Math.max(0,i-1)],next=closed&&i===n-1?points[1]:points[Math.min(n-1,i+1)];
    let tx=next[0]-prev[0],ty=next[1]-prev[1];const len=Math.hypot(tx,ty)||1;tx/=len;ty/=len;
    const angle=Math.atan2(ty,tx),pen=Math.abs(Math.sin(angle-NIB))**2.1,edge=(i===0||i===n-1)&&!closed?.86:1;
    const half=(THIN+(THICK-THIN)*pen)*weight*.5*edge*(1+Math.sin(i*.34+breath)*.035);
    left.push([points[i][0]-ty*half,points[i][1]+tx*half]);right.push([points[i][0]+ty*half,points[i][1]-tx*half]);
  }
  return [[...left,...right.reverse()]];
}
function serif(point,kind,direction,random){
  const length=(kind==='s'?96:76)*(.88+random()*.24),[x,y]=point,thick=21+random()*5,lift=direction>0?1:-1,polys=[];
  const tick=(from,to)=>polys.push([[x+from,y-thick*lift*.2],[x+to,y-thick*lift*.2],[x+to+(to>from?-6:6),y+thick*lift*.75],[x+from+(to>from?30:-30)*.9,y+thick*lift*1.8],[x+from,y+thick*lift*.8]].map(p=>p));
  if(kind!=='r')tick(-6,-length);
  if(kind!=='l')tick(6,length);
  return polys;
}
function drawGlyph(strokes,seed){
  const random=rng(seed*7919+13),shake=wobble(random,9),contours=[];
  for(const stroke of strokes){
    if(!Array.isArray(stroke))continue;
    const [d,ends='--',weight=1]=stroke,points=sample(d).map(shake);
    contours.push(...ribbon(points,weight,random));
    const first=points[0],last=points.at(-1),goesUp=last[1]>first[1];
    if(ends[0]!=='-')contours.push(...serif(first,ends[0],goesUp?1:-1,random));
    if(ends[1]!=='-')contours.push(...serif(last,ends[1],goesUp?-1:1,random));
  }
  return contours;
}
const signedArea=ring=>{let a=0;for(let i=0,j=ring.length-1;i<ring.length;j=i++)a+=(ring[j][0]-ring[i][0])*(ring[j][1]+ring[i][1]);return a/2;};
// TrueType fills clockwise contours; all pieces must agree so overlaps add up.
const clockwise=ring=>signedArea(ring)<0?[...ring].reverse():ring;

// ---------- Glyph table ----------
const glyphs=[{unicode:null,advance:500,contours:[]},{unicode:32,advance:270,contours:[]},{unicode:160,advance:270,contours:[]}];
const byChar=new Map();
for(const [char,[advance,...strokes]] of Object.entries(G)){
  const contours=drawGlyph(strokes.map(s=>Array.isArray(s)?s:[s]),seedCounter++);
  const glyph={unicode:char.codePointAt(0),advance,contours,strokes};glyphs.push(glyph);byChar.set(char,glyph);
}
const shifted=(contours,dx,dy=0)=>contours.map(ring=>ring.map(([x,y])=>[x+dx,y+dy]));
function mark(code,center,top,seed){
  const def=MARKS[code];if(!def)return [];
  const strokes=[];for(let i=0;i<def.length;i++)if(def[i]!==undefined)strokes.push([def[i],'--',.68]);
  const contours=drawGlyph(strokes,seed),xs=contours.flat().map(p=>p[0]),width=(Math.min(...xs)+Math.max(...xs))/2;
  return shifted(contours,center-width,top);
}
const added=new Set();
function addAccented(cp){
  if(added.has(cp)||byChar.has(String.fromCodePoint(cp)))return;
  const char=String.fromCodePoint(cp),parts=[...char.normalize('NFD')];
  if(SPECIAL[char]){
    const seq=[...SPECIAL[char]];let x=0,contours=[];for(const c of seq){const g=byChar.get(c);contours.push(...shifted(g.contours,x));x+=g.advance*.92;}
    if('ØøŁłĐđÐ'.includes(char)){const bar=/[Øø]/.test(char)?['M60 -10L'+(x-50)+' '+(char==='Ø'?710:440),'--',.5]:['M'+(/[ŁĐÐ]/.test(char)?10:20)+' 300L'+(/[ŁĐÐ]/.test(char)?240:210)+' '+(/[Łł]/.test(char)?440:300),'--',.55];contours.push(...drawGlyph([bar],cp));}
    glyphs.push({unicode:cp,advance:Math.round(x+(seq.length>1?0:byChar.get(seq[0]).advance*.08)),contours});added.add(cp);return;
  }
  if(parts.length<2)return;
  const base=byChar.get(parts[0]);if(!base)return;
  let contours=base.contours.slice();const capital=parts[0]>='A'&&parts[0]<='Z'||/[bdfhkl]/.test(parts[0]),center=base.advance/2;
  for(const code of parts.slice(1)){
    if(code==='̧'||code==='̨'){const tail=code==='̧'?'M'+center+' 0C'+(center+40)+' -40 '+(center+60)+' -100 '+(center-40)+' -150':'M'+(center+70)+' 0C'+(center+20)+' -70 '+(center+40)+' -130 '+(center+110)+' -130';contours=[...contours,...drawGlyph([[tail,'--',.6]],cp)];continue;}
    if(!MARKS[code])return;
    contours=[...contours,...mark(code,center,capital?752:492,cp)];
  }
  glyphs.push({unicode:cp,advance:base.advance,contours});added.add(cp);
}
for(let cp=0xA0;cp<=0x24F;cp++)addAccented(cp);
for(let cp=0x1E00;cp<=0x1EFF;cp++)addAccented(cp);
glyphs.slice(1).sort((a,b)=>a.unicode-b.unicode);
const notdef=glyphs.shift();glyphs.sort((a,b)=>a.unicode-b.unicode);glyphs.unshift(notdef);
for(const glyph of glyphs){
  glyph.rings=glyph.contours.map(ring=>clockwise(ring.map(([x,y])=>[Math.round(x),Math.round(y)]))).map(ring=>ring.filter((p,i)=>{const q=ring[(i+ring.length-1)%ring.length];return p[0]!==q[0]||p[1]!==q[1];})).filter(ring=>ring.length>=3);
  const xs=glyph.rings.flat().map(p=>p[0]),ys=glyph.rings.flat().map(p=>p[1]);
  glyph.box=xs.length?[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]:[0,0,0,0];
}

// ---------- TrueType tables ----------
const u16=v=>{const b=Buffer.alloc(2);b.writeUInt16BE(v&0xffff);return b;},i16=v=>{const b=Buffer.alloc(2);b.writeInt16BE(v);return b;},u32=v=>{const b=Buffer.alloc(4);b.writeUInt32BE(v>>>0);return b;};
function encodeGlyph({rings,box}){
  if(!rings.length)return Buffer.alloc(0);
  const parts=[i16(rings.length),...box.map(i16)];let end=-1;for(const ring of rings){end+=ring.length;parts.push(u16(end));}
  parts.push(u16(0));
  const flags=[],xs=[],ys=[];let px=0,py=0;
  for(const ring of rings)for(const [x,y] of ring){
    const dx=x-px,dy=y-py;let flag=1;
    if(dx===0)flag|=16;else if(Math.abs(dx)<256){flag|=2;if(dx>0)flag|=16;xs.push(Buffer.from([Math.abs(dx)]));}else xs.push(i16(dx));
    if(dy===0)flag|=32;else if(Math.abs(dy)<256){flag|=4;if(dy>0)flag|=32;ys.push(Buffer.from([Math.abs(dy)]));}else ys.push(i16(dy));
    flags.push(flag);px=x;py=y;
  }
  parts.push(Buffer.from(flags),...xs,...ys);
  const body=Buffer.concat(parts);return body.length%2?Buffer.concat([body,Buffer.alloc(1)]):body;
}
const bodies=glyphs.map(encodeGlyph),loca=[];let at=0;for(const body of bodies){loca.push(u32(at));at+=body.length;}loca.push(u32(at));
const all=glyphs.flatMap(g=>g.rings.flat()),allX=all.map(p=>p[0]),allY=all.map(p=>p[1]);
const box=[Math.min(...allX),Math.min(...allY),Math.max(...allX),Math.max(...allY)],maxPoints=Math.max(...glyphs.map(g=>g.rings.reduce((a,r)=>a+r.length,0))),maxContours=Math.max(...glyphs.map(g=>g.rings.length));
const stamp=Buffer.alloc(8);
const head=Buffer.concat([u32(0x00010000),u32(0x00010000),u32(0),u32(0x5F0F3CF5),u16(0b1011),u16(1000),stamp,stamp,...box.map(i16),u16(BOLD?1:0),u16(8),i16(2),i16(1),i16(0)]);
const ascent=880,descent=-280,advanceMax=Math.max(...glyphs.map(g=>g.advance));
const minLeft=Math.min(...glyphs.filter(g=>g.rings.length).map(g=>g.box[0])),minRight=Math.min(...glyphs.filter(g=>g.rings.length).map(g=>g.advance-g.box[2])),extent=Math.max(...glyphs.filter(g=>g.rings.length).map(g=>g.box[2]));
const hhea=Buffer.concat([u32(0x00010000),i16(ascent),i16(descent),i16(0),u16(advanceMax),i16(minLeft),i16(minRight),i16(extent),i16(1),i16(0),i16(0),i16(0),i16(0),i16(0),i16(0),i16(0),u16(glyphs.length)]);
const hmtx=Buffer.concat(glyphs.flatMap(g=>[u16(g.advance),i16(g.box[0])]));
const maxp=Buffer.concat([u32(0x00010000),u16(glyphs.length),u16(maxPoints),u16(maxContours),u16(0),u16(0),u16(2),u16(0),u16(0),u16(0),u16(0),u16(0),u16(0),u16(0),u16(0)]);
const os2=Buffer.concat([u16(3),i16(500),u16(BOLD?700:400),u16(5),u16(0),i16(650),i16(650),i16(0),i16(120),i16(650),i16(650),i16(0),i16(420),i16(40),i16(260),i16(2),Buffer.alloc(10),u32(1),u32(2),u32(0),u32(0),Buffer.from('RDLN'),u16(BOLD?0x20:0x40),u16(32),u16(0xFFFF),i16(ascent),i16(descent),i16(0),u16(ascent+120),u16(-descent+40),u32(1),u32(0),i16(442),i16(700),u16(0),u16(32),u16(0)]);
const post=Buffer.concat([u32(0x00030000),u32(0),i16(-80),i16(40),u32(0),u32(0),u32(0),u32(0),u32(0)]);
const names=[[0,'Drawn for Redline, 2026.'],[1,'Redline Hand'],[2,BOLD?'Bold':'Regular'],[3,`Redline Hand ${BOLD?'Bold':'Regular'} 1.0`],[4,BOLD?'Redline Hand Bold':'Redline Hand'],[5,'Version 1.0'],[6,`RedlineHand-${BOLD?'Bold':'Regular'}`]];
const nameStrings=names.map(([,text])=>Buffer.from(text,'utf16le').swap16());let nameOffset=0;
const nameTable=Buffer.concat([u16(0),u16(names.length),u16(6+names.length*12),...names.flatMap(([id],i)=>{const record=[u16(3),u16(1),u16(0x409),u16(id),u16(nameStrings[i].length),u16(nameOffset)];nameOffset+=nameStrings[i].length;return record;}),...nameStrings]);
function cmapTable(){
  const entries=glyphs.map((g,i)=>[g.unicode,i]).filter(([u])=>u!==null&&u<0x10000).sort((a,b)=>a[0]-b[0]),segments=[];
  for(const [code,index] of entries){const last=segments.at(-1);if(last&&last.end+1===code&&last.first+(code-last.start)===index)last.end=code;else segments.push({start:code,end:code,first:index});}
  segments.push({start:0xFFFF,end:0xFFFF,first:0});
  const count=segments.length,range=2**Math.floor(Math.log2(count))*2;
  const subtable=Buffer.concat([u16(4),u16(16+count*8),u16(0),u16(count*2),u16(range),u16(Math.log2(range/2)),u16(count*2-range),...segments.map(s=>u16(s.end)),u16(0),...segments.map(s=>u16(s.start)),...segments.map(s=>u16((s.first-s.start)&0xffff)),...segments.map(()=>u16(0))]);
  return Buffer.concat([u16(0),u16(1),u16(3),u16(1),u32(12),subtable]);
}
function kernTable(){
  const index=new Map(glyphs.map((g,i)=>[g.unicode,i])),pairs=[];
  for(const [pair,value] of Object.entries(KERN)){const [a,b]=[...pair];const left=index.get(a.codePointAt(0)),right=index.get(b.codePointAt(0));if(left&&right)pairs.push([left,right,value]);}
  pairs.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const n=pairs.length,range=2**Math.floor(Math.log2(n))*6;
  return Buffer.concat([u16(0),u16(1),u16(0),u16(14+n*6),u16(1),u16(n),u16(range),u16(Math.log2(range/6)),u16(n*6-range),...pairs.flatMap(([a,b,v])=>[u16(a),u16(b),i16(v)])]);
}
const tables={'OS/2':os2,cmap:cmapTable(),glyf:Buffer.concat(bodies),head,hhea,hmtx,kern:kernTable(),loca:Buffer.concat(loca),maxp,name:nameTable,post};
const checksum=buffer=>{let sum=0;const padded=Buffer.concat([buffer,Buffer.alloc((4-buffer.length%4)%4)]);for(let i=0;i<padded.length;i+=4)sum=sum+padded.readUInt32BE(i)>>>0;return sum;};
// ---------- WOFF wrapper ----------
const tags=Object.keys(tables).sort(),sfntSize=12+tags.length*16+tags.reduce((a,t)=>a+Math.ceil(tables[t].length/4)*4,0);
// head's checksum adjustment is computed over the equivalent sfnt.
{const entrySelector=Math.floor(Math.log2(tags.length)),searchRange=2**entrySelector*16,directory=[u32(0x00010000),u16(tags.length),u16(searchRange),u16(entrySelector),u16(tags.length*16-searchRange)];let offset=12+tags.length*16;const body=[];for(const tag of tags){const table=tables[tag];directory.push(Buffer.from(tag.padEnd(4)),u32(checksum(table)),u32(offset),u32(table.length));const padded=Buffer.concat([table,Buffer.alloc((4-table.length%4)%4)]);body.push(padded);offset+=padded.length;}
head.writeUInt32BE((0xB1B0AFBA-checksum(Buffer.concat([...directory,...body])))>>>0,8);}
const directory=[],blobs=[];let offset=44+tags.length*20;
for(const tag of tags){
  const table=tables[tag],compressed=deflateSync(table,{level:9}),data=compressed.length<table.length?compressed:table;
  directory.push(Buffer.from(tag.padEnd(4)),u32(offset),u32(data.length),u32(table.length),u32(checksum(table)));
  const padded=Buffer.concat([data,Buffer.alloc((4-data.length%4)%4)]);blobs.push(padded);offset+=padded.length;
}
const woff=Buffer.concat([Buffer.from('wOFF'),u32(0x00010000),u32(offset),u16(tags.length),u16(0),u32(sfntSize),u16(1),u16(0),u32(0),u32(0),u32(0),u32(0),u32(0),...directory,...blobs]);
const target=new URL('../public/fonts/',import.meta.url);fs.mkdirSync(target,{recursive:true});
fs.writeFileSync(new URL(BOLD?'redline-hand-bold.woff':'redline-hand.woff',target),woff);
console.log(`Redline Hand${BOLD?' Bold':''}`,glyphs.length,'glyphs',woff.length,'bytes');
