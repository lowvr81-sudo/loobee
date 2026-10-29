import express from 'express';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const app = express();
const PORT = Number(process.env.PORT || 8787);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SAMPLE_SECONDS = 2;
const PADDING_SECONDS = 2.5;
const MAX_BYTES = 500 * 1024 * 1024;
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: MAX_BYTES, files: 1 } });

app.use((req, res, next) => {
  const allowed = (process.env.ALLOWED_ORIGIN || '*').split(',').map(x => x.trim());
  const origin = req.headers.origin;
  if (allowed.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg failed (${code}): ${stderr.slice(-2500)}`)));
  });
}
function mergeRanges(ranges, duration) {
  const sorted = ranges.map(([a,b]) => [Math.max(0,a), Math.min(duration,b)]).filter(([a,b]) => b > a).sort((x,y)=>x[0]-y[0]);
  const merged=[];
  for (const r of sorted) {
    const last=merged[merged.length-1];
    if (last && r[0] <= last[1]) last[1]=Math.max(last[1],r[1]);
    else merged.push([...r]);
  }
  return merged;
}
async function probeDuration(file) {
  // ffmpeg's null output reports duration; parse it without adding another native dependency.
  try {
    await run(['-hide_banner','-i',file,'-f','null','-']);
  } catch (e) {
    const m = String(e.message).match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1])*3600 + Number(m[2])*60 + Number(m[3]);
    throw new Error('Could not read this video. Try MP4, MOV or WebM.');
  }
  throw new Error('Could not determine video duration.');
}
async function getDuration(file) {
  // Use FFmpeg stderr output directly, since probing a media file normally exits non-zero without an output target.
  return await new Promise((resolve, reject) => {
    const p=spawn(ffmpegPath,['-hide_banner','-i',file,'-f','null','-'],{stdio:['ignore','ignore','pipe']});
    let stderr='';p.stderr.on('data',d=>stderr+=d.toString());
    p.on('error',reject);p.on('close',()=>{const m=stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);if(!m)return reject(new Error('Could not read video duration. Try MP4, MOV or WebM.'));resolve(Number(m[1])*3600+Number(m[2])*60+Number(m[3]));});
  });
}
async function moderateFrames(frames) {
  const flagged=[];
  // Small batches reduce request count; API keys remain on this server.
  for (let i=0; i<frames.length; i+=6) {
    const batch=frames.slice(i,i+6);
    const input=batch.map(f=>({type:'image_url',image_url:{url:`data:image/jpeg;base64,${f.base64}`}}));
    const response=await fetch('https://api.openai.com/v1/moderations',{
      method:'POST',headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({model:'omni-moderation-latest',input})
    });
    if(!response.ok) throw new Error(`AI video scan failed (${response.status}). Try again later.`);
    const json=await response.json();
    const results=json.results||[];
    for(let j=0;j<batch.length;j++){
      const cats=results[j]?.categories||{};
      // Remove frames flagged for sexual content, graphic violence, or self-harm.
      if(cats.sexual===true || cats['sexual/minors']===true || cats.violence===true || cats['violence/graphic']===true || cats['self-harm']===true || cats['self-harm/intent']===true || cats['self-harm/instructions']===true) flagged.push(batch[j].time);
    }
  }
  return flagged;
}
app.get('/health', (_req,res)=>res.json({ok:true,service:'Loobee video safety processor'}));
app.post('/process-video', upload.single('video'), async (req,res) => {
  const inputFile=req.file?.path;
  let workDir;
  try {
    if(!SUPABASE_URL||!SUPABASE_ANON_KEY||!OPENAI_API_KEY) return res.status(503).json({error:'Processor is not configured. Set SUPABASE_URL, SUPABASE_ANON_KEY and OPENAI_API_KEY.'});
    const auth=(req.headers.authorization||'').match(/^Bearer\s+(.+)$/i);
    if(!auth) return res.status(401).json({error:'Sign in to Loobee before processing a video.'});
    const sb=createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:{user},error:authErr}=await sb.auth.getUser(auth[1]);
    if(authErr||!user) return res.status(401).json({error:'Your Loobee session expired. Sign in again.'});
    if(!req.file) return res.status(400).json({error:'Choose a video file.'});
    workDir=await fs.mkdtemp(path.join(os.tmpdir(),'loobee-scan-'));
    const duration=await getDuration(inputFile);
    if(!Number.isFinite(duration)||duration<=0||duration>1800) return res.status(422).json({error:'Videos must be 30 minutes or shorter for automatic safety scanning.'});
    const framesDir=path.join(workDir,'frames');await fs.mkdir(framesDir);
    await run(['-hide_banner','-loglevel','error','-i',inputFile,'-vf',`fps=1/${SAMPLE_SECONDS},scale=512:-2`,'-q:v','5',path.join(framesDir,'frame-%05d.jpg')]);
    const names=(await fs.readdir(framesDir)).filter(n=>n.endsWith('.jpg')).sort();
    if(!names.length) return res.status(422).json({error:'Could not scan frames in this video.'});
    if(names.length>900) return res.status(422).json({error:'This video has too many frames for safe automatic processing.'});
    const frames=[];
    for(let i=0;i<names.length;i++) frames.push({time:Math.min(i*SAMPLE_SECONDS,duration),base64:(await fs.readFile(path.join(framesDir,names[i]))).toString('base64')});
    const flagged=await moderateFrames(frames);
    const remove=mergeRanges(flagged.map(t=>[t-PADDING_SECONDS,t+PADDING_SECONDS]),duration);
    const removedSeconds=remove.reduce((n,[a,b])=>n+b-a,0);
    if(removedSeconds/duration>0.6) return res.status(422).json({error:'A large part of this video appears to contain unsafe material. It was not uploaded; edit it manually and try again.'});
    const safe=[];let cursor=0;
    for(const [a,b] of remove){if(a-cursor>0.25)safe.push([cursor,a]);cursor=Math.max(cursor,b)}
    if(duration-cursor>0.25)safe.push([cursor,duration]);
    if(!safe.length) return res.status(422).json({error:'No safe section remains after scanning. This video was not uploaded.'});
    const output=path.join(workDir,'loobee-cleaned.mp4');
    if(remove.length===0){
      await run(['-hide_banner','-loglevel','error','-i',inputFile,'-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-movflags','+faststart','-y',output]);
    } else {
      const parts=[];
      for(let i=0;i<safe.length;i++){
        const part=path.join(workDir,`safe-${i}.mp4`);const [start,end]=safe[i];
        await run(['-hide_banner','-loglevel','error','-ss',String(start),'-to',String(end),'-i',inputFile,'-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-avoid_negative_ts','make_zero','-y',part]);
        parts.push(part);
      }
      const listPath=path.join(workDir,'concat.txt');
      await fs.writeFile(listPath,parts.map(p=>`file '${p.replace(/'/g,"'\\''")}'`).join('\n'));
      await run(['-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',listPath,'-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-movflags','+faststart','-y',output]);
    }
    res.setHeader('Content-Type','video/mp4');
    res.setHeader('Content-Disposition','attachment; filename="loobee-cleaned.mp4"');
    res.setHeader('X-Loobee-Removed-Segments',String(remove.length));
    res.setHeader('X-Loobee-Removed-Seconds',String(Math.round(removedSeconds)));
    res.setHeader('Access-Control-Expose-Headers','X-Loobee-Removed-Segments, X-Loobee-Removed-Seconds');
    res.sendFile(output, async err=>{await fs.rm(workDir,{recursive:true,force:true}).catch(()=>{});if(err&&!res.headersSent)res.status(500).end('Could not return the processed video.');});
    workDir=null;
  } catch(err) {
    console.error('Video processor error:',err?.message||err);
    if(!res.headersSent)res.status(500).json({error:err?.message||'Video processing failed.'});
  } finally {
    if(inputFile) await fs.rm(inputFile,{force:true}).catch(()=>{});
    if(workDir) await fs.rm(workDir,{recursive:true,force:true}).catch(()=>{});
  }
});
app.listen(PORT,()=>console.log(`Loobee video safety processor listening on ${PORT}`));
