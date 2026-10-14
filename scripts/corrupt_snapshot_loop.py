import os, sys, time, glob

# Continuously flip the EOCD central-directory offset byte of the newest
# snapshot zip under the snapshot root. After each engine regeneration the file
# is rebuilt good; this keeps re-corrupting it so every upload+verify round
# ships a broken package until the engine exhausts its internal verify attempts
# and the publish job fails. Works across every workspace: whichever one the
# engine is actively generating for becomes the newest target.
snap_root = os.environ.get("SLIDEFORGE_SNAPSHOT_SYNC_ROOT", r"<workspace-snapshot-sync-root>")
duration = float(sys.argv[1]) if len(sys.argv) > 1 else 600.0
deadline = time.time() + duration
last = None
print(f"corrupt-loop started ({duration}s) watching {snap_root}", flush=True)
while time.time() < deadline:
    zips = []
    for root, _, files in os.walk(snap_root):
        if os.path.basename(root) != "snapshots":
            continue
        for name in files:
            if name.endswith(".zip"):
                zips.append(os.path.join(root, name))
    if zips:
        p = max(zips, key=lambda f: os.path.getmtime(f))
        if p != last:
            print("now targeting", os.path.basename(p), flush=True)
            last = p
        try:
            if os.path.getsize(p) > 22:
                with open(p, "r+b") as f:
                    f.seek(-22 + 16, 2)
                    b = f.read(1)
                    f.seek(-22 + 16, 2)
                    f.write(bytes([b[0] ^ 0xFF]))
        except OSError:
            pass
    time.sleep(0.03)
print("corrupt-loop done", flush=True)
