import asyncio
from bleak import BleakScanner, BleakClient
W="0000ff02-0000-1000-8000-00805f9b34fb"; N="0000ff03-0000-1000-8000-00805f9b34fb"
async def main():
    d = await BleakScanner.find_device_by_name("TP88", timeout=10)
    async with BleakClient(d) as c:
        print("mtu", c.mtu_size)
        await c.start_notify(N, lambda _,b: print("reply", b.hex(" ")))
        for cmd in ([0x1f,0x11,0x08],[0x1f,0x11,0x11],[0x1f,0x11,0x07]):
            await c.write_gatt_char(W, bytes(cmd), response=False); await asyncio.sleep(0.6)
if __name__ == "__main__":
    asyncio.run(main())
