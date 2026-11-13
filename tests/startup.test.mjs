import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {detectSerialSupport,serialErrorMessage,ONLINE_URL} from '../serial-support.mjs';
import {Acquisition} from '../acquisition.mjs';

const supported=()=>({location:{protocol:'https:'},isSecureContext:true,navigator:{serial:{async requestPort(){}}}});
test('standalone secure browsers with Web Serial are supported',()=>assert.equal(detectSerialSupport(supported()).supported,true));
for(const [name,patch,code] of [
 ['local file',{location:{protocol:'file:'}},'local-file'],
 ['insecure HTTP',{isSecureContext:false},'insecure'],
 ['browser without serial API',{navigator:{}},'unsupported'],
 ['frame without serial permission',{document:{permissionsPolicy:{allowsFeature:()=>false}}},'blocked-policy']
])test(name+' has a specific explanation instead of a dead connection button',()=>{
 const result=detectSerialSupport({...supported(),...patch});assert.equal(result.supported,false);assert.equal(result.code,code);assert.ok(result.message.length>15);
});
test('cancellation, permission denial and busy ports have distinct actionable messages',()=>{
 assert.match(serialErrorMessage({name:'NotFoundError'}),/未选择串口/);
 assert.match(serialErrorMessage({name:'SecurityError'}),/未允许串口/);
 assert.match(serialErrorMessage({name:'NetworkError'}),/PulseScope/);
 assert.match(serialErrorMessage({name:'InvalidStateError'}),/占用/);
});
test('file entry redirects to the public app without importing local modules or transmitting file paths',async()=>{
 const code=await readFile(new URL('../boot.js',import.meta.url),'utf8'),warning={hidden:true},message={};let destination;
 vm.runInNewContext(code,{location:{protocol:'file:',replace:url=>destination=url},document:{getElementById:id=>id==='startup-warning'?warning:message}});
 assert.equal(destination,ONLINE_URL);assert.equal(new URL(destination).protocol,'https:');assert.ok(!destination.includes('Users'));assert.equal(warning.hidden,false);assert.match(message.textContent,/在线版/);
});
test('a blocked local redirect keeps a visible route to the online app',async()=>{
 const code=await readFile(new URL('../boot.js',import.meta.url),'utf8'),warning={hidden:true},message={};
 assert.doesNotThrow(()=>vm.runInNewContext(code,{location:{protocol:'file:',replace(){throw new Error('blocked');}},document:{getElementById:id=>id==='startup-warning'?warning:message}}));
 assert.equal(warning.hidden,false);assert.match(message.textContent,/点击/);
});
async function withBrowserGlobals(env,run){
 const keys=['location','isSecureContext','navigator','document'],previous=new Map(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
 try{for(const key of keys)Object.defineProperty(globalThis,key,{value:env[key],configurable:true});await run();}
 finally{for(const key of keys){const old=previous.get(key);if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];}}
}
test('busy serial open leaves the app retryable and reports the cause persistently',async()=>{
 const notices=[],env=supported();env.navigator.serial.requestPort=async()=>({async open(){throw Object.assign(new Error('Failed to open serial port'),{name:'NetworkError'});}});
 await withBrowserGlobals(env,async()=>{const a=new Acquisition({onNotice:text=>notices.push(text)});await assert.rejects(a.connect(),/PulseScope/);assert.equal(a.connecting,false);assert.equal(a.connected,false);assert.equal(a.port,null);assert.match(notices.at(-1),/占用/);});
});
test('cancelling a port picker does not stop an existing synthetic preview',async()=>{
 const notices=[],env=supported();env.navigator.serial.requestPort=async()=>{throw Object.assign(new Error('No port selected'),{name:'NotFoundError'});};
 await withBrowserGlobals(env,async()=>{const a=new Acquisition({onNotice:text=>notices.push(text)});a.source='synthetic';a.connected=true;await assert.rejects(a.connect(),/未选择串口/);assert.equal(a.connected,true);assert.equal(a.source,'synthetic');assert.equal(a.connecting,false);assert.match(notices.at(-1),/未选择/);});
});
