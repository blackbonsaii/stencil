import serial, time, sys
import glob
PORT = glob.glob("/dev/cu.usbmodem*")[0]
s = serial.Serial(PORT, 115200, timeout=0.5)
def q(name, b):
    s.reset_input_buffer()
    s.write(bytes(b)); s.flush(); time.sleep(0.4)
    r = s.read(256)
    print(f"{name:14} -> {r.hex(' ') if r else '(no reply)'}")
# Known Phomemo/Quin read-only queries
q("battery",  [0x1f,0x11,0x08])
q("paper",    [0x1f,0x11,0x11])
q("firmware", [0x1f,0x11,0x07])
q("serial",   [0x1f,0x11,0x09])
q("cover",    [0x1f,0x11,0x12])
q("printstat",[0x10,0x04,0x01])
q("model",    [0x1d,0x49,0x01])
s.close()
