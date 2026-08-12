'use strict';

const CLIENT_VERSION='2.5.0-unique-id-led';

const UUID = {
  service: '12345678-1234-5678-1234-56789abcdef0',
  data: '12345678-1234-5678-1234-56789abcdef1',
  control: '12345678-1234-5678-1234-56789abcdef2'
};
const EVT = { MOUNTED:0x10, UNMOUNTED:0x11, READY:0x20, COMPLETE:0x21, CHUNK:0x22, LOG:0x30, VERSION:0x31, ERROR:0xee };
const ERRORS = {1:'Micro:bit is not mounted',2:'Programmer is busy',3:'Invalid command',4:'Could not create FIRMWARE.HEX',5:'Unexpected data offset',6:'USB write failed',7:'File size check failed',8:'CRC32 check failed',9:'USB flush/close failed'};

const $ = id => document.getElementById(id);
const ui = {
  connect:$('connect'),disconnect:$('disconnect'),program:$('program'),
  file:$('file'),drop:$('drop'),fileMeta:$('fileMeta'),fileState:$('fileState'),
  progressPanel:$('progress'),meter:$('meter'),percent:$('percent'),phaseLabel:$('phaseLabel'),
  progressLabel:$('progressLabel'),progressBytes:$('progressBytes'),progressTiming:$('progressTiming'),
  log:$('log'),versions:$('versions'),bleDot:$('bleDot'),bleText:$('bleText'),
  usbDot:$('usbDot'),usbText:$('usbText'),flashDot:$('flashDot'),flashText:$('flashText')
};
let device, dataCharacteristic, controlCharacteristic, fileBytes, fileName;
let connected = false, mounted = false, flashing = false, waiter = null;
let acknowledgedOffset = 0, ackWaiter = null, programmingStarted = 0;

function log(message) {
  ui.log.textContent += `${new Date().toLocaleTimeString()}  ${message}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
}
function setDot(dot, state='') { dot.className = state; }
function updateProgramButton() { ui.program.disabled = !(connected && mounted && fileBytes && !flashing); }
function setFlash(text, state='') { ui.flashText.textContent=text; setDot(ui.flashDot,state); }
function formatBytes(bytes) {
  if(bytes<1024)return `${Math.round(bytes)} B`;
  return `${(bytes/1024).toFixed(bytes<10240?1:0)} KB`;
}
function setProgress(percent,phase,label,bytes='0 B / 0 B',timing='Ready',state='') {
  const value=Math.max(0,Math.min(100,Math.floor(percent)));
  ui.meter.value=value;
  ui.percent.textContent=`${value}%`;
  ui.phaseLabel.textContent=phase;
  ui.progressLabel.textContent=label;
  ui.progressBytes.textContent=bytes;
  ui.progressTiming.textContent=timing;
  ui.progressPanel.className=`panel progress-panel${state?` ${state}`:''}`;
}
function resetProgress() {
  setProgress(0,'Waiting to start · 0 of 2 completed','Choose a HEX file and connect the Programmer.');
}
function handleFirmwareProgress(message) {
  const match=message.match(/DEBUG RAW_PROGRESS:\s+(\d+)\/(\d+)/);
  if(!match)return;
  const written=Number(match[1]),total=Number(match[2]);
  const percent=Math.min(100,Math.floor(written*100/total));
  const elapsed=Math.max((performance.now()-programmingStarted)/1000,.1);
  setProgress(percent,'Step 2 of 2 · Programming micro:bit',
    'Writing the verified HEX to the micro:bit. Keep both devices powered.',
    `${formatBytes(written)} / ${formatBytes(total)}`,
    `${formatBytes(written/elapsed)}/s`,'programming');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit=0; bit<8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function u32(bytes, offset=0) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset,true); }
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));

function awaitEvent(code, timeout=8000) {
  if (waiter) throw new Error('Another Programmer operation is pending');
  return new Promise((resolve,reject) => {
    const timer=setTimeout(()=>{if(waiter){waiter=null;reject(new Error('Programmer response timed out'));}},timeout);
    waiter={code,resolve:value=>{clearTimeout(timer);waiter=null;resolve(value);},reject:error=>{clearTimeout(timer);waiter=null;reject(error);}};
  });
}
function cancelWait(error) { if (waiter) waiter.reject(error); }
function cancelAckWait(error) {
  if (!ackWaiter) return;
  clearTimeout(ackWaiter.timer);
  const reject=ackWaiter.reject;ackWaiter=null;reject(error);
}
function awaitAcknowledgedOffset(target,timeout=15000) {
  if(acknowledgedOffset>=target) return Promise.resolve(acknowledgedOffset);
  if(ackWaiter) throw new Error('Another data window is pending');
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(ackWaiter){ackWaiter=null;reject(new Error(`Programmer acknowledgement timed out at ${target}`));}},timeout);
    ackWaiter={target,timer,resolve,reject};
  });
}

function onNotification(event) {
  const bytes = new Uint8Array(event.target.value.buffer,event.target.value.byteOffset,event.target.value.byteLength);
  const code=bytes[0];
  if (code===EVT.MOUNTED || code===EVT.UNMOUNTED) {
    mounted=code===EVT.MOUNTED; ui.usbText.textContent=mounted?'Micro:bit mounted':'Not mounted'; setDot(ui.usbDot,mounted?'ok':''); updateProgramButton();
    log(mounted?'Micro:bit USB drive mounted.':'Micro:bit USB drive disconnected.');
  } else if (code===EVT.LOG) {
    const rawMessage=new TextDecoder().decode(bytes.subarray(1)).trim();
    const message=rawMessage.replace(/ESP32(?:-S3)?/gi,'Programmer');
    handleFirmwareProgress(message);log(`Programmer · ${message}`);
  } else if (code===EVT.VERSION) {
    const firmwareVersion=new TextDecoder().decode(bytes.subarray(1));
    ui.versions.textContent=`Build · Web v${CLIENT_VERSION} · Programmer v${firmwareVersion}`;
    log(`Version check: Web v${CLIENT_VERSION}, Programmer firmware v${firmwareVersion}.`);
  } else if (code===EVT.ERROR) {
    const error=new Error(ERRORS[bytes[1]] || `Programmer error 0x${(bytes[1]||0).toString(16)}`);cancelWait(error);cancelAckWait(error);
  } else if (code===EVT.CHUNK) {
    acknowledgedOffset=Math.max(acknowledgedOffset,u32(bytes,1));
    if(ackWaiter && acknowledgedOffset>=ackWaiter.target) {
      clearTimeout(ackWaiter.timer);const resolve=ackWaiter.resolve;ackWaiter=null;resolve(acknowledgedOffset);
    }
  } else if (waiter && waiter.code===code) {
    waiter.resolve(bytes);
  }
}

async function connect() {
  if (!navigator.bluetooth) { log('Web Bluetooth is unavailable. Use Chrome or Edge via HTTPS or localhost.'); return; }
  try {
    device=await navigator.bluetooth.requestDevice({filters:[{services:[UUID.service]}]});
    device.addEventListener('gattserverdisconnected',disconnected);
    const server=await device.gatt.connect();
    const service=await server.getPrimaryService(UUID.service);
    dataCharacteristic=await service.getCharacteristic(UUID.data);
    controlCharacteristic=await service.getCharacteristic(UUID.control);
    await controlCharacteristic.startNotifications();
    controlCharacteristic.addEventListener('characteristicvaluechanged',onNotification);
    connected=true; ui.bleText.textContent='Connected'; setDot(ui.bleDot,'ok'); ui.connect.hidden=true; ui.disconnect.hidden=false;
    log('Connected to Programmer.');
    await controlCharacteristic.writeValueWithResponse(Uint8Array.of(0x01));
    await sleep(100);
    await controlCharacteristic.writeValueWithResponse(Uint8Array.of(0x06));
    updateProgramButton();
  } catch(error) { if(error.name!=='NotFoundError') log(`Connection failed: ${error.message}`); disconnected(); }
}
function disconnected() {
  cancelWait(new Error('Bluetooth disconnected'));
  cancelAckWait(new Error('Bluetooth disconnected'));
  connected=mounted=flashing=false; dataCharacteristic=controlCharacteristic=null;
  ui.versions.textContent=`Build · Web v${CLIENT_VERSION} · Programmer not connected`;
  ui.bleText.textContent='Disconnected';ui.usbText.textContent='Unknown';setDot(ui.bleDot);setDot(ui.usbDot);setFlash('Idle');ui.connect.hidden=false;ui.disconnect.hidden=true;updateProgramButton();
}

async function selectFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.hex')) { log('Choose a file ending in .hex.'); return; }
  if (file.size===0 || file.size>4*1024*1024) { log('HEX file must be between 1 byte and 4 MB.'); return; }
  const bytes=new Uint8Array(await file.arrayBuffer());
  const beginning=new TextDecoder().decode(bytes.subarray(0,Math.min(bytes.length,128))).trimStart();
  if (!beginning.startsWith(':')) { log('This does not look like an Intel or Universal HEX file.'); return; }
  fileBytes=bytes;fileName=file.name;
  ui.fileMeta.textContent=`${file.name} · ${(file.size/1024).toFixed(1)} KB · CRC32 ${crc32(bytes).toString(16).padStart(8,'0').toUpperCase()}`;
  ui.fileState.textContent='Ready';ui.drop.classList.add('chosen');
  setProgress(0,'Ready to start · 0 of 2 completed','The HEX file is ready. Connect the Programmer and start programming.',`0 B / ${formatBytes(fileBytes.length)}`,'Ready');
  log(`Selected ${file.name} (${file.size.toLocaleString()} bytes).`);updateProgramButton();
}

async function commandAndWait(command,eventCode,timeout=8000) {
  const response=awaitEvent(eventCode,timeout);
  try {
    await controlCharacteristic.writeValueWithResponse(command);
  } catch(writeError) {
    // START and END can include a slow file open or flush. The command is
    // successful if its explicit Programmer event arrives despite a generic GATT error.
    try { return await response; }
    catch(_) { cancelWait(writeError); throw writeError; }
  }
  return response;
}

async function sendWindow(offset,payloadSize,windowSize) {
  let sentOffset=offset;
  for(let packetIndex=0;packetIndex<windowSize && sentOffset<fileBytes.length;packetIndex++) {
    const length=Math.min(payloadSize,fileBytes.length-sentOffset);
    const packet=new Uint8Array(length+4);
    new DataView(packet.buffer).setUint32(0,sentOffset,true);
    packet.set(fileBytes.subarray(sentOffset,sentOffset+length),4);
    await dataCharacteristic.writeValueWithoutResponse(packet);
    sentOffset+=length;
  }
  await awaitAcknowledgedOffset(sentOffset,15000);
  return sentOffset;
}

async function program() {
  flashing=true;updateProgramButton();setFlash('Programming…','busy');
  setProgress(0,'Step 1 of 2 · Caching HEX in Programmer','Sending the HEX securely over Bluetooth.',`0 B / ${formatBytes(fileBytes.length)}`,'Starting…','caching');
  try {
    const start=new Uint8Array(9),view=new DataView(start.buffer);start[0]=0x02;view.setUint32(1,fileBytes.length,true);view.setUint32(5,crc32(fileBytes),true);
    log(`Caching ${fileName} in Programmer memory…`);
    await commandAndWait(start,EVT.READY);
    acknowledgedOffset=0;
    let offset=0, payloadSize=232, windowSize=6, started=performance.now();
    log(`Fast Bluetooth streaming enabled: ${payloadSize}-byte packets, window ${windowSize}.`);
    while(offset<fileBytes.length) {
      try { offset=await sendWindow(offset,payloadSize,windowSize); }
      catch(error) {
        if(offset===0 && payloadSize>16 && /length|size|GATT|Network/i.test(error.message)) { payloadSize=16;windowSize=1;log('Using compatibility Bluetooth packet size.');continue; }
        throw error;
      }
      const pct=Math.floor(offset*100/fileBytes.length),seconds=Math.max((performance.now()-started)/1000,.1);
      setProgress(pct,'Step 1 of 2 · Caching HEX in Programmer','Receiving and verifying the HEX before programming.',
        `${formatBytes(offset)} / ${formatBytes(fileBytes.length)}`,`${formatBytes(offset/seconds)}/s`,'caching');
    }
    setProgress(100,'Step 1 of 2 · Cache complete','HEX cached and CRC verified.',
      `${formatBytes(fileBytes.length)} / ${formatBytes(fileBytes.length)}`,'✓ 1 of 2 completed','cache-complete');
    await sleep(500);
    programmingStarted=performance.now();
    setProgress(0,'Step 2 of 2 · Programming micro:bit','Writing the verified HEX to the micro:bit. Keep both devices powered.',
      `0 B / ${formatBytes(fileBytes.length)}`,'✓ 1 of 2 completed','programming');
    log('Step 1 complete. Programmer is now writing the verified HEX to the micro:bit.');
    await commandAndWait(Uint8Array.of(0x03),EVT.COMPLETE,120000);
    setProgress(100,'Programming complete · ✓ 2 of 2 completed','micro:bit programmed successfully.',
      `${formatBytes(fileBytes.length)} / ${formatBytes(fileBytes.length)}`,'Safe to use','complete');
    setFlash('Complete','ok');log('Programming complete. The micro:bit may disconnect and reboot now.');
  } catch(error) {
    setProgress(ui.meter.value,'Programming stopped',`Failed: ${error.message}`,ui.progressBytes.textContent,'Check Activity for details','failed');
    setFlash('Failed');log(`Programming failed: ${error.message}`);
    try { if(connected) await controlCharacteristic.writeValueWithResponse(Uint8Array.of(0x04)); } catch(_) {}
  } finally { flashing=false;updateProgramButton(); }
}

ui.connect.addEventListener('click',connect);
ui.disconnect.addEventListener('click',()=>device?.gatt?.disconnect());
ui.program.addEventListener('click',program);
ui.file.addEventListener('change',event=>selectFile(event.target.files[0]));
for(const name of ['dragenter','dragover']) ui.drop.addEventListener(name,event=>{event.preventDefault();ui.drop.classList.add('over');});
for(const name of ['dragleave','drop']) ui.drop.addEventListener(name,event=>{event.preventDefault();ui.drop.classList.remove('over');});
ui.drop.addEventListener('drop',event=>selectFile(event.dataTransfer.files[0]));
$('clear').addEventListener('click',()=>ui.log.textContent='');
$('copyLog').addEventListener('click',async event=>{
  const button=event.currentTarget;
  const text=ui.log.textContent;
  if(!text){button.textContent='Log is empty';setTimeout(()=>button.textContent='Copy log',1400);return;}
  try {
    if(navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.append(area);area.select();
      if(!document.execCommand('copy')) throw new Error('Copy command was rejected');
      area.remove();
    }
    button.textContent='Copied!';
  } catch(error) {
    button.textContent='Copy failed';
    log(`Could not copy log: ${error.message}`);
  }
  setTimeout(()=>button.textContent='Copy log',1400);
});
if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(()=>{});
resetProgress();
log(`Web app v${CLIENT_VERSION} ready. Connect the Programmer to begin.`);
