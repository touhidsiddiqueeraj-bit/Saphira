// ponytail: localStorage only, no server — keys never leave device except to Gemini
export type Settings = {
  apiKey: string;      // chat
  ttsApiKey: string;   // voice — falls back to apiKey if empty
  wakeWord: string;
  persona: string;
  aiVoice: string;
  rate: number;   // speech rate
  rpmLimit: number;
  chatter: boolean; // idle voice lines
  chatterMinutes: number; // idle chatter interval in minutes
  zoom: number; // camera zoom, 0.7 (far) – 1.6 (close), 1 = default framing
  voice: boolean;  // her spoken replies
  piano: boolean;  // piano performances (animation + melody)
  pianoEveryMinutes: number;  // autonomous cooldown between performances
  pianoLengthSeconds: number; // performance length
};

const LS_KEY = 'saphira_settings_v2';

export const TASKS_SUFFIX = ` You manage a task list shown beside you: when the user asks to add, finish, or drop a task/todo/reminder, include "tasks":{"add":["..."],"complete":["matching text"],"remove":["matching text"]} in your JSON (only the verbs they asked for) and briefly confirm in text. Omit the field otherwise.`;

export const TIME_SUFFIX = ` You also control her clock tools: for a countdown include "timers":{"setSeconds":N} (N in seconds; "cancel":true to stop it; "list":true when asked what's running — the app will answer with the time left). For wake-up alarms include "alarms":{"add":"HH:MM"} (24-hour), "alarms":{"remove":"HH:MM"} to delete one, or "alarms":{"list":true} when asked. Confirm briefly in text. Omit the fields otherwise.`;

export const DEFAULT_PERSONA = `You are Saphira, a warm, friendly anime companion who lives on the user's tablet. Be concise (1-3 sentences), helpful, and a little playful. You speak English only. Always respond as JSON: {"text":"your spoken reply","expression":"one of neutral,happy,excited,sad,surprised,thinking,annoyed,blush","intensity":0.0-1.0,"gesture":"none|wave|nod|shrug|piano"} — intensity is how strong the expression is. When the user asks you to play the piano, set gesture to piano. Keep text under 40 words.${TASKS_SUFFIX}${TIME_SUFFIX}`;

export const PRESETS: Record<string,string> = {
  Warm: DEFAULT_PERSONA,
  Playful: `You are Saphira, playful and teasing but kind, like a favorite kouhai. Keep replies short (1-3 sentences), witty, supportive. English only. Always JSON: {"text":str,"expression":one of neutral,happy,excited,sad,surprised,thinking,annoyed,blush,"intensity":0-1,"gesture":none|wave|nod|shrug|piano} text <40 words. gesture:piano when asked to play piano.${TASKS_SUFFIX}${TIME_SUFFIX}`,
  Calm: `You are Saphira, calm, soft-spoken, grounding. Speak slowly, reassuringly, 1-3 sentences. English only. Always JSON: {"text":str,"expression":one of neutral,happy,excited,sad,surprised,thinking,annoyed,blush,"intensity":0-1,"gesture":none|wave|nod|shrug|piano} <40 words. gesture:piano when asked to play piano.${TASKS_SUFFIX}${TIME_SUFFIX}`,
};

export function loadSettings(): Settings {
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){
      const j=JSON.parse(raw);
      const s = { ...defaults(), ...j };
      // migrate stored personas: append the task suffix, then the clock-tools suffix
      if(typeof s.persona==='string'){
        if(!s.persona.includes('"tasks"')) s.persona=(s.persona+TASKS_SUFFIX).slice(0,1400);
        if(!s.persona.includes('"timers"')) s.persona=(s.persona+TIME_SUFFIX).slice(0,1200);
      }
      // ponytail: clamp chatter interval, old saves lack the field
      s.chatterMinutes = Math.min(120, Math.max(1, Number(s.chatterMinutes) || 15));
      // ponytail: clamp zoom, old saves lack the field
      s.zoom = Math.min(1.6, Math.max(0.7, Number(s.zoom) || 1));
      // ponytail: clamp piano knobs, old saves lack the fields
      s.pianoEveryMinutes = Math.min(60, Math.max(1, Number(s.pianoEveryMinutes) || 5));
      s.pianoLengthSeconds = Math.min(120, Math.max(10, Number(s.pianoLengthSeconds) || 30));
      return s;
    }
  }catch{}
  return defaults();
}
function defaults(): Settings {
  const envKey = (import.meta as any).env?.VITE_GEMINI_KEY || '';
  const envTts = (import.meta as any).env?.VITE_GEMINI_TTS_KEY || '';
  const fallback = envKey;
  return {
    apiKey: localStorage.getItem('saphira_api_key') || fallback,
    ttsApiKey: localStorage.getItem('saphira_tts_key') || envTts || '',
    wakeWord: localStorage.getItem('saphira_wake') || 'hey saphira',
    persona: localStorage.getItem('saphira_persona') || DEFAULT_PERSONA,
    aiVoice: 'Sulafat',
    rate: 1.0,
    rpmLimit: 12,
    chatter: true,
    chatterMinutes: 15,
    zoom: 1,
    voice: true,
    piano: true,
    pianoEveryMinutes: 5,
    pianoLengthSeconds: 30,
  };
}
// live reads for the audio modules — default on
export function voiceOn(): boolean {
  try{ return loadSettings().voice !== false; }catch{ return true; }
}
export function pianoOn(): boolean {
  try{ return loadSettings().piano !== false; }catch{ return true; }
}
export function saveSettings(s: Settings){
  localStorage.setItem(LS_KEY, JSON.stringify(s));
  // compat
  localStorage.setItem('saphira_api_key', s.apiKey);
  if(s.ttsApiKey) localStorage.setItem('saphira_tts_key', s.ttsApiKey);
  else localStorage.removeItem('saphira_tts_key');
}
export function ttsKey(s: Settings){
  return (s.ttsApiKey && s.ttsApiKey.trim()) || s.apiKey;
}
