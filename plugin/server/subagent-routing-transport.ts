import { createHash, randomUUID } from "node:crypto";
import { constants, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";

export type SubagentRoutingDescriptor = { version: 1; socketPath: string; capability: string; agentId: string; sessionId: string; runtimeEpoch: string; serviceEpoch: string };
export function subagentRoutingDescriptorPath(agentId: string, baseDir = join(homedir(), ".pi", "paseo-bridge")) { return join(baseDir, "operators", `${createHash("sha256").update(agentId).digest("hex")}.subagents.json`); }
export async function readSubagentRoutingDescriptor(agentId: string, baseDir = join(homedir(), ".pi", "paseo-bridge")): Promise<unknown> {
 if (!agentId || agentId.length > 256) return undefined;
 try { const dir = join(baseDir,"operators"), ds = await lstat(dir); if (!ds.isDirectory() || ds.isSymbolicLink() || (typeof process.getuid === "function" && ds.uid !== process.getuid()) || (ds.mode & 0o777)!==0o700) return undefined;
  const h=await open(subagentRoutingDescriptorPath(agentId,baseDir),constants.O_RDONLY|(constants.O_NOFOLLOW??0)); try { const s=await h.stat(); if(!s.isFile()||(typeof process.getuid==="function"&&s.uid!==process.getuid())||(s.mode&0o777)!==0o600||s.size>4096)return undefined; return JSON.parse(await h.readFile("utf8")); } finally { await h.close(); }
 } catch { return undefined; }
}
export function validateSubagentRoutingDescriptor(v: unknown, agentId: string): v is SubagentRoutingDescriptor {
 if(!v||typeof v!=="object"||Array.isArray(v))return false; const d=v as any;
 return Object.keys(d).sort().join(",")==="agentId,capability,runtimeEpoch,serviceEpoch,sessionId,socketPath,version"&&d.version===1&&d.agentId===agentId&&typeof d.socketPath==="string"&&d.socketPath.startsWith("/")&&d.socketPath.length<=4096&&typeof d.capability==="string"&&/^[a-f0-9]{64}$/.test(d.capability)&&typeof d.sessionId==="string"&&d.sessionId.length>0&&d.sessionId.length<=256&&typeof d.runtimeEpoch==="string"&&/^[a-f0-9-]{36}$/.test(d.runtimeEpoch)&&typeof d.serviceEpoch==="string"&&d.serviceEpoch.length>0&&d.serviceEpoch.length<=256;
}
export function callSubagentRouting(d: SubagentRoutingDescriptor, request: Record<string,unknown>, timeoutMs=15_000): Promise<unknown> {
 const id=randomUUID(), frame=`${JSON.stringify({v:1,type:"subagent_routing",id,capability:d.capability,agentId:d.agentId,sessionId:d.sessionId,runtimeEpoch:d.runtimeEpoch,serviceEpoch:d.serviceEpoch,request})}\n`;
 if(Buffer.byteLength(frame)>32*1024)throw new Error("Oversized subagent-routing request");
 return new Promise((resolve,reject)=>{let socket:ReturnType<typeof connect>|undefined,settled=false,buffer="";const decoder=new StringDecoder("utf8");const timer=setTimeout(()=>finish(new Error("Subagent-routing request timed out")),timeoutMs);const finish=(e?:Error,v?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);socket?.destroy();e?reject(e):resolve(v);};
 void(async()=>{try{const st=await lstat(d.socketPath);if(!st.isSocket()||(typeof process.getuid==="function"&&st.uid!==process.getuid())||(st.mode&0o777)!==0o600)throw new Error("Subagent-routing socket is not private");socket=connect(d.socketPath);socket.setTimeout(timeoutMs,()=>finish(new Error("Subagent-routing request timed out")));socket.once("error",e=>finish(e));socket.once("connect",()=>socket!.write(frame));socket.on("data",chunk=>{buffer+=decoder.write(chunk);if(Buffer.byteLength(buffer)>128*1024){finish(new Error("Oversized subagent-routing response"));return;}const nl=buffer.indexOf("\n");if(nl<0)return;try{if(nl!==buffer.length-1)throw new Error("Unexpected subagent-routing framing");const r=JSON.parse(buffer.slice(0,nl));if(!r||r.v!==1||r.type!=="subagent_routing"||r.id!==id||typeof r.success!=="boolean")throw new Error("Invalid subagent-routing response");if(!r.success)throw new Error(typeof r.error==="string"?r.error:"Subagent-routing request failed");if(r.agentId!==d.agentId||r.sessionId!==d.sessionId||r.runtimeEpoch!==d.runtimeEpoch||r.serviceEpoch!==d.serviceEpoch)throw new Error("Subagent-routing identity mismatch");finish(undefined,r.data);}catch(e){finish(e instanceof Error?e:new Error(String(e)));}});socket.once("end",()=>{buffer+=decoder.end();if(!settled)finish(new Error("Subagent-routing bridge closed without response"));});}catch(e){finish(e instanceof Error?e:new Error(String(e)));}})();
 });
}
