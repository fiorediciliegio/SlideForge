import os, sys, time, glob
snap_dir = os.environ.get("SLIDEFORGE_SNAPSHOT_SNAP_DIR", r"<workspace-snapshot-snapshots-dir>")
known = set(glob.glob(os.path.join(snap_dir, "*.zip")))
print("watching", snap_dir, "known zips:", sorted(known), flush=True)
for _ in range(12000):                     # ~5 分钟窗口
    for p in glob.glob(os.path.join(snap_dir, "*.zip")):
        if p in known: continue
        with open(p, "r+b") as f:          # 翻转 EOCD 中央目录偏移字段
            f.seek(-22 + 16, 2)
            b = f.read(1)
            f.seek(-22 + 16, 2)
            f.write(bytes([b[0] ^ 0xFF]))
        print("corrupted", p, flush=True)
        sys.exit(0)
    known = set(glob.glob(os.path.join(snap_dir, "*.zip")))
    time.sleep(0.03)
print("window missed — 再做一次编辑即可")
