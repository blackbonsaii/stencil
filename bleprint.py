"""Print over Bluetooth LE using the TP88's credit-based flow control."""
import asyncio, sys, time
from bleak import BleakScanner, BleakClient
from PIL import Image, ImageDraw
from tp88 import to_bitmap
W="0000ff02-0000-1000-8000-00805f9b34fb"; N="0000ff03-0000-1000-8000-00805f9b34fb"
WB=208

class Link:
    def __init__(self, c):
        self.c=c; self.credits=0; self.mtu=20; self.ev=asyncio.Event(); self.log=[]
    def on(self,_,b):
        self.log.append(b.hex(' '))
        if b[0]==0x01: self.credits+=b[1]; self.ev.set()
        elif b[0]==0x02: self.mtu=int.from_bytes(b[1:3],'little')
    async def send(self, data):
        for i in range(0,len(data),self.mtu):
            while self.credits<=0:
                self.ev.clear(); await asyncio.wait_for(self.ev.wait(), 10)
            self.credits-=1
            await self.c.write_gatt_char(W, data[i:i+self.mtu], response=False)

def job(raw,h,density=4):
    out=bytearray(b"\x1b\x40"+b"\x1d\x28\x4b\x02\x00\x31"+bytes([density]))
    for y in range(0,h,255):
        n=min(255,h-y)
        out+=b"\x1d\x76\x30\x00"+WB.to_bytes(2,'little')+n.to_bytes(2,'little')+raw[y*WB:(y+n)*WB]
    return bytes(out+b"\x1b\x64\x02")

async def main():
    img=Image.new("L",(WB*8,710),255); d=ImageDraw.Draw(img)
    d.rectangle([200,508,1463,709],outline=0,width=3)
    d.text((230,590),"BLE TEST - box top should be 2.5 in from top edge",fill=0)
    raw,h=to_bitmap(img,WB)
    data=job(raw,h)
    dev=await BleakScanner.find_device_by_name("TP88",timeout=10)
    async with BleakClient(dev) as c:
        L=Link(c); await c.start_notify(N,L.on); await asyncio.sleep(1)
        print("credits",L.credits,"mtu",L.mtu,"bytes",len(data))
        t=time.time(); await L.send(data); print(f"sent in {time.time()-t:.1f}s")
        await asyncio.sleep(4); print("notifies:", L.log[-5:])
if __name__ == "__main__":
    asyncio.run(main())
