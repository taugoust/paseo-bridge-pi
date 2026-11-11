import assert from "node:assert/strict";
import test from "node:test";
import * as net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeTransport } from "../extension/bridge-transport.ts";
import { accountControlsSocketPath } from "../extension/account-controls-operator.js";

test("account-controls private socket authenticates separate capability and rechecks identity after operation",async()=>{
 const root=await mkdtemp(join(tmpdir(),"accounts-socket-")),pipe=join(root,"bridge.sock"),transport=new BridgeTransport("session-file",pipe);
 const identity={agentId:"agent",sessionId:"session",runtimeEpoch:transport.operatorEpoch,serviceEpoch:"service",capability:transport.accountControlsCapability};let calls=0;
 transport.bind({command:async()=>{},attached(){},detached(){},error(){},accountControlsIdentity:()=>identity,accountControls:async request=>{calls++;return {request};}});transport.start();
 try{
  const socket=net.connect(accountControlsSocketPath(pipe));await once(socket,"connect");
  const response=await new Promise<any>((resolve,reject)=>{let data="";socket.on("data",c=>{data+=c.toString();if(data.includes("\n"))resolve(JSON.parse(data));});socket.once("error",reject);socket.write(`${JSON.stringify({v:1,type:"account_controls",id:"r1",capability:identity.capability,agentId:identity.agentId,sessionId:identity.sessionId,runtimeEpoch:identity.runtimeEpoch,serviceEpoch:identity.serviceEpoch,request:{operation:"snapshot",sessionId:identity.sessionId,providerId:"openai-codex"}})}\n`);});
  assert.equal(response.success,true);assert.equal(response.data.request.operation,"snapshot");assert.equal(calls,1);socket.destroy();
 }finally{transport.close();await rm(root,{recursive:true,force:true});}
});
