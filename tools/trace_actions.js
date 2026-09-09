'use strict';
/**
 * SFN-ASSERTION GATE for the action emitter.
 *
 * Reads {sfn, actions, expected_sfn} records on stdin (one JSON per line), replays
 * `actions` on a real live Board with the REAL applyAITurn, and reports whether the
 * result matches `expected_sfn`.
 *
 * This is the safety net for the emitter. A silent divergence would corrupt
 * turns[].actions, which feeds game review, reconstructGameLog, SGN export and
 * ai/import_human_games.py — so the emitter must never ship without this passing.
 */
const fs=require('fs'), path=require('path'), vm=require('vm'), readline=require('readline');
const dir=process.argv[2];
const FILES=['constants.js','notation.js','board.js','moves.js','spells.js','sim-board.js',
  'features.js','sigil-net.js','sigil-net-graph.js','strategic-eval.js','enumerator.js',
  'mcts.js','minimax-ai.js','caveman-ai.js','ai-player.js'];
const parts=FILES.map(f=>{
  const p=path.join(dir,f);
  if(!fs.existsSync(p)) return `// missing ${f}`;
  return fs.readFileSync(p,'utf8');
});
// applyAITurn awaits _aiDelay(400..600) between actions for the animations. That
// is thousands of seconds across a gate run, so stub it out. It is a top-level
// `function` in a classic script, i.e. a global property, so reassigning works.
parts.push(`;try { _aiDelay = () => Promise.resolve(); } catch (e) {}`);
parts.push(`;globalThis.__E={SimBoard,SimTurn,SimAction,applyAITurn,boardToSfn,
  Board:(typeof Board!=='undefined'?Board:null),
  SigilBoard:(typeof SigilBoard!=='undefined'?SigilBoard:null),
  NODE_ORDER};`);
vm.runInThisContext(parts.join('\n;\n'),{filename:'bundle.js'});
const E=globalThis.__E;

function boardFromSfn(sfn){
  // Build a SimBoard from SFN by hand: the JS SimBoard has no SFN reader.
  const [head,...rest]=sfn.split(' ');
  const [stones,spells]=head.split('/');
  const b=new E.SimBoard(spells.split(','), rest[7]||'standard');
  E.NODE_ORDER.forEach((n,i)=>{
    const ch=stones[i];
    b.stones[n]= ch==='r'?'red': ch==='b'?'blue': ch==='x'?'X': null;
  });
  b.whoseTurn = rest[0]==='b'?'blue':'red';
  b.turnCounter=parseInt(rest[1],10);
  const [rsc,bsc]=rest[2].split(':'); b.spellCounter={red:+rsc,blue:+bsc};
  const nn=v=>v==='-'?null:v;
  const [rl,bl]=rest[3].split(':'); b.lock={red:nn(rl),blue:nn(bl)};
  const [rs,bs]=rest[4].split(':'); b.springlock={red:nn(rs),blue:nn(bs)};
  // applyAITurn is written against the LIVE Board, which has a few members
  // SimBoard lacks. Shim exactly what it touches; everything else it uses
  // (stones, lock, springlock, spellCounter, snares, update) SimBoard already has.
  b.enemy = (col) => (col === 'red' ? 'blue' : 'red');
  b.getBoardStatePayload = () => ({});
  if (b.movesLeftThisTurn === undefined) b.movesLeftThisTurn = 1;
  if (b.movesGrantedThisTurn === undefined) b.movesGrantedThisTurn = 0;
  if (!b.snares) b.snares = {};
  b.update();
  return b;
}


// PREFIX TRACE. `applyAITurn` applies a whole turn, so to see the board
// BETWEEN actions we replay prefixes on a fresh board each time. That is the
// only way to answer the question this exists for: a recorded Fireblast turn
// keeps only c10 and then sacrifices c9, a node the cast should have cleared,
// so either the sigil is not fully cleared before the sacrifice or the action
// order is not the board-mutation order. The real engine settles it.
const rl=readline.createInterface({input:process.stdin});
let chain=Promise.resolve();
const out=[];
rl.on('line', l=>{ chain=chain.then(()=>handle(l)); });
rl.on('close', ()=>{ chain.then(()=>{
  console.log(JSON.stringify(out));
  process.exit(0);
});});

function stonesOf(b){
  return E.NODE_ORDER.map(n => b.stones[n]==='red'?'r'
    : b.stones[n]==='blue'?'b' : b.stones[n]==='X'?'x' : '.').join('');
}

async function handle(line){
  if(!line.trim()) return;
  let rec; try{ rec=JSON.parse(line); }catch(e){ return; }
  const steps=[];
  for(let k=1;k<=rec.actions.length;k++){
    const pre=rec.actions.slice(0,k);
    let row={k, action:pre[k-1] && pre[k-1].type};
    try{
      const b=boardFromSfn(rec.sfn);
      const color=b.whoseTurn;
      await E.applyAITurn(b, {actions:pre}, color, ()=>{});
      b.update();
      row.stones=stonesOf(b);
      row.detail=JSON.stringify(pre[k-1]);
    }catch(e){
      row.error=String(e&&e.message||e).slice(0,160);
      row.detail=JSON.stringify(pre[k-1]);
    }
    steps.push(row);
  }
  out.push({key:rec.key, sfn:rec.sfn, sigil:rec.sigil, steps,
            expected:rec.expected_sfn});
}
