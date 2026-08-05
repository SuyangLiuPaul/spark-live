import json, os, sys, time, threading, urllib.request, urllib.error, uuid, statistics
B="https://spark-live-translate.netlify.app"
wav=open("win_360.wav","rb").read()
import struct
pcm=wav[44:][:16000*6*2]                       # 6s window — typical for the engine
WAV=(b"RIFF"+struct.pack("<I",36+len(pcm))+b"WAVEfmt "+struct.pack("<IHHIIHH",16,1,1,16000,32000,2,16)
     +b"data"+struct.pack("<I",len(pcm))+pcm)
SYS='Correct then translate. Reply JSON only: {"corrected":"...","tr":{"prs":"...","en":"..."}}'
TXT="首先就是我們的視力，你看見我，我看見你。"
MINUTES=float(sys.argv[1]) if len(sys.argv)>1 else 5
VENUES=3
res={}; lock=threading.Lock()

def venue(name):
    a_ok=a_429=a_err=c_ok=c_429=c_err=0; a_lat=[]; c_lat=[]
    start=time.time(); next_chat=start+6
    while time.time()-start < MINUTES*60:
        cyc=time.time()
        b=uuid.uuid4().hex
        body=(f'--{b}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n'
              f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
              f'Content-Type: audio/wav\r\n\r\n').encode()+WAV+f"\r\n--{b}--\r\n".encode()
        t0=time.time()
        try:
            urllib.request.urlopen(urllib.request.Request(B+"/api/asr",body,
                {"Content-Type":f"multipart/form-data; boundary={b}"}),timeout=90).read()
            a_ok+=1; a_lat.append(time.time()-t0)
        except urllib.error.HTTPError as e:
            if e.code==429: a_429+=1
            else: a_err+=1
        except Exception: a_err+=1
        if time.time()>=next_chat:
            t0=time.time()
            try:
                urllib.request.urlopen(urllib.request.Request(B+"/api/chat",
                    json.dumps({"sys":SYS,"prompt":TXT}).encode(),
                    {"content-type":"application/json"}),timeout=90).read()
                c_ok+=1; c_lat.append(time.time()-t0)
            except urllib.error.HTTPError as e:
                if e.code==429: c_429+=1
                else: c_err+=1
            except Exception: c_err+=1
            next_chat=time.time()+6
        slack=2.2-(time.time()-cyc)
        if slack>0: time.sleep(slack)
    with lock:
        res[name]=dict(asr_ok=a_ok,asr_429=a_429,asr_err=a_err,chat_ok=c_ok,chat_429=c_429,chat_err=c_err,
                       asr_p50=statistics.median(a_lat) if a_lat else 0,
                       asr_p95=sorted(a_lat)[int(len(a_lat)*.95)-1] if len(a_lat)>2 else 0,
                       chat_p50=statistics.median(c_lat) if c_lat else 0)

print(f"simulating {VENUES} venues running simultaneously for {MINUTES:g} min on ONE 8-key pool\n")
ts=[threading.Thread(target=venue,args=(f"venue-{i+1}",)) for i in range(VENUES)]
t0=time.time()
for t in ts: t.start()
for t in ts: t.join()

print(f"{'venue':<10}{'ASR ok':>8}{'429':>6}{'err':>6}{'p50':>8}{'p95':>8}{'chat ok':>9}{'429':>6}{'p50':>8}")
tot=dict(a=0,a4=0,c=0,c4=0,e=0)
for k in sorted(res):
    v=res[k]
    print(f"{k:<10}{v['asr_ok']:>8}{v['asr_429']:>6}{v['asr_err']:>6}{v['asr_p50']:>7.2f}s{v['asr_p95']:>7.2f}s"
          f"{v['chat_ok']:>9}{v['chat_429']:>6}{v['chat_p50']:>7.2f}s")
    tot['a']+=v['asr_ok']; tot['a4']+=v['asr_429']; tot['c']+=v['chat_ok']; tot['c4']+=v['chat_429']; tot['e']+=v['asr_err']+v['chat_err']
el=time.time()-t0
print(f"\n  aggregate: {tot['a']} ASR + {tot['c']} chat in {el/60:.1f} min")
print(f"  throttled: {tot['a4']} ASR 429, {tot['c4']} chat 429   other errors: {tot['e']}")
print(f"  combined draw: one ASR every {el/max(1,tot['a']):.2f}s across all venues")
print(f"  quota used: {tot['a']/16000*100:.2f}% of daily ASR, {tot['c']/8000*100:.2f}% of daily chat")
hrs=16000*(el/max(1,tot['a']))/3600
print(f"\n  => with 3 venues sharing the pool it lasts ~{hrs:.1f} h ({hrs*60:.0f} min) of simultaneous use")
print("  VERDICT:", "clean — 3 venues fit" if tot['a4']+tot['c4']+tot['e']==0 else "contention detected")
