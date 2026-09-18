// Saphira's reply contract + the tolerant parser that turns whatever the brain
// says into a valid SaphiraReply. Shared by the Gemini web path and the
// desktop OpenAI-compatible / local-LLM paths.
export type SaphiraReply = {
  text: string;
  expression: 'neutral'|'happy'|'excited'|'sad'|'surprised'|'thinking'|'annoyed'|'blush';
  intensity: number;
  gesture: 'none'|'wave'|'nod'|'shrug'|'piano';
  tasks?: { add?: string[]; complete?: string[]; remove?: string[] };
  timers?: { setSeconds?: number; cancel?: boolean; list?: boolean };
  alarms?: { add?: string; remove?: string; list?: boolean };
};

const VALID_EXPR = new Set(['neutral','happy','excited','sad','surprised','thinking','annoyed','blush']);
const VALID_GEST = new Set(['none','wave','nod','shrug','piano']);

export function parseReply(raw:string): SaphiraReply {
  // reasoning models wrap output in <think> blocks — never let that reach the
  // parser or her voice
  raw = String(raw||'')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
  let j:any=null;
  try{ j = JSON.parse(raw); }catch{
    // try extract json block
    const m = raw.match(/\{[\s\S]*\}/);
    if(m) try{ j=JSON.parse(m[0]); }catch{}
  }
  if(!j || (!j.text && !j.message && !j.reply && !j.response)){
    // unknown JSON shape — prefer likely message keys, else the first string
    let first='';
    const scan=(v:any, depth=0)=>{
      if(first || depth>3 || v==null) return;
      if(typeof v==='string'){ first=v.trim(); return; }
      if(Array.isArray(v)){ v.forEach(x=>scan(x,depth+1)); return; }
      if(typeof v==='object'){ Object.values(v).forEach(x=>scan(x,depth+1)); }
    };
    let best='';
    if(j && typeof j==='object'){
      for(const k of ['greeting','prompt','answer','content','output','response_text']){
        const v=(j as any)[k];
        if(typeof v==='string' && v.trim()){ best=v.trim(); break; }
      }
    }
    if(!best && j) scan(j);
    const text = best || first || (typeof raw==='string' && raw.trim()) || "I'm here — say that again?";
    return { text: String(text).slice(0,400), expression:'neutral', intensity:0.6, gesture:'none' };
  }
  let expr = String(j.expression||'neutral').toLowerCase();
  if(!VALID_EXPR.has(expr)) expr='neutral';
  let gest = String(j.gesture||'none').toLowerCase();
  if(!VALID_GEST.has(gest)) gest='none';
  let intensity = Number(j.intensity ?? 0.7);
  if(!isFinite(intensity)) intensity=0.7;
  intensity = Math.max(0, Math.min(1, intensity));
  let text = String(j.text ?? j.message ?? j.reply ?? j.response ?? '').trim();
  if(text.length>400) text=text.slice(0,397)+'...';
  if(!text) text="I'm listening.";
  const out: SaphiraReply = { text, expression: expr as any, intensity, gesture: gest as any };
  // optional task-list ops: {add:[...], complete:[...], remove:[...]}
  const tj = (j as any).tasks;
  if(tj && typeof tj==='object'){
    const strs=(v:any)=> Array.isArray(v) ? v.filter((x:any)=>typeof x==='string'&&x.trim()).map((x:string)=>x.trim().slice(0,120)).slice(0,5) : [];
    const ops = { add: strs(tj.add), complete: strs(tj.complete), remove: strs(tj.remove) };
    if(ops.add.length||ops.complete.length||ops.remove.length) out.tasks=ops;
  }
  // optional timer ops: {setSeconds:N, cancel:true, list:true}
  const tm = (j as any).timers;
  if(tm && typeof tm==='object'){
    const secs = Math.max(0, Math.min(6*3600, Number(tm.setSeconds)||0));
    const ops = { setSeconds: secs || undefined, cancel: !!tm.cancel, list: !!tm.list };
    if(ops.setSeconds||ops.cancel||ops.list) out.timers=ops;
  }
  // optional alarm ops: {add:'HH:MM', remove:'HH:MM', list:true}
  const al = (j as any).alarms;
  if(al && typeof al==='object'){
    const okTime=(v:any)=> typeof v==='string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim());
    const ops = { add: okTime(al.add)? al.add.trim() : undefined, remove: okTime(al.remove)? al.remove.trim() : undefined, list: !!al.list };
    if(ops.add||ops.remove||ops.list) out.alarms=ops;
  }
  return out;
}
