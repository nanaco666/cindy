"""
Sign a Windows .exe via npkg code-signing service.
Usage: python sign.py <exe_path> <token>
"""
import sys, os, time, zipfile, tempfile, shutil, subprocess

# Bootstrap: signing machines / CI don't always have `requests` preinstalled.
# If it's missing, install it into the *current* interpreter (the same `python`
# that forge postPackage / publish-windows / release-windows spawn us as) and
# retry the import, instead of aborting the whole release with a bare
# ModuleNotFoundError -> exit 1. Hit this in practice on a fresh Python install.
try:
    import requests
except ImportError:
    print("[sign.py] 'requests' not found — installing into current interpreter...", flush=True)
    subprocess.run([sys.executable, "-m", "pip", "install", "requests"], check=True)
    import requests

if len(sys.argv) < 3:
    print("Usage: python sign.py <exe_path> <token>")
    sys.exit(1)

exe_path = os.path.abspath(sys.argv[1])
token = sys.argv[2]

if not os.path.isfile(exe_path):
    print(f"File not found: {exe_path}")
    sys.exit(1)

exe_name = os.path.basename(exe_path)
tmp_dir = tempfile.mkdtemp(prefix="npkg-sign-")
zip_path = os.path.join(tmp_dir, exe_name + ".zip")
signed_zip_path = os.path.join(tmp_dir, "signed.zip")

headers = {"Authorization": f"Token {token}"}

try:
    # 1. Zip — use a simple name to avoid npkg issues with special chars
    zip_path = os.path.join(tmp_dir, "sign_target.zip")
    print(f"[1] Zipping {exe_name}...")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(exe_path, exe_name)

    # 2. Upload
    print("[2] Uploading...")
    with open(zip_path, "rb") as f:
        files = [("file", (os.path.basename(zip_path), f, "application/octet-stream"))]
        resp = requests.post(
            "https://npkg.xindong.com/api/v1/packages/",
            headers=headers,
            data={"memo": f"xdt-maker-sign-{int(time.time())}"},
            files=files,
        )

    data = resp.json()

    # Handle conflict
    if resp.status_code == 409 and data.get("conflict_id"):
        print(f"    Conflict (ID {data['conflict_id']}), deleting and retrying...")
        requests.delete(
            f"https://npkg.xindong.com/api/v1/packages/{data['conflict_id']}/",
            headers=headers,
        )
        with open(zip_path, "rb") as f:
            files = [("file", (os.path.basename(zip_path), f, "application/octet-stream"))]
            resp = requests.post(
                "https://npkg.xindong.com/api/v1/packages/",
                headers=headers,
                data={"memo": f"xdt-maker-sign-retry-{int(time.time())}"},
                files=files,
            )
        data = resp.json()

    if resp.status_code not in (200, 201):
        print(f"Upload failed: {data}")
        sys.exit(1)

    package_id = data["id"]
    print(f"    Package ID: {package_id}")

    # 3. Poll
    print("[3] Waiting for signing...")
    sign_file_url = None
    for _ in range(30):
        status_resp = requests.get(
            f"https://npkg.xindong.com/api/v1/packages/{package_id}/",
            headers=headers,
        )
        status_data = status_resp.json()
        if status_data.get("sign_status") == "completed":
            sign_file_url = status_data.get("sign_file")
            print("    Signing completed!")
            break
        elif status_data.get("sign_status") == "failed":
            print("    Signing failed on server!")
            sys.exit(1)
        else:
            print(f"    {status_data.get('sign_status', 'unknown')}...")
            time.sleep(3)

    if not sign_file_url:
        print("Signing timed out!")
        sys.exit(1)

    # 4. Download
    sign_file_url = "https://npkg.xindong.com" + sign_file_url
    print(f"[4] Downloading: {sign_file_url}")
    res = requests.get(sign_file_url, stream=True, timeout=3600)
    if res.status_code != 200:
        print(f"    Download failed: {res.status_code}")
        print(f"    Response: {res.text[:200]}")
        sys.exit(1)

    with open(signed_zip_path, "wb") as fp:
        for chunk in res.iter_content(chunk_size=65536):
            if chunk:
                fp.write(chunk)

    signed_size = os.path.getsize(signed_zip_path)
    print(f"    Downloaded {signed_size} bytes")

    # 5. Extract and replace
    print("[5] Extracting...")
    extract_dir = os.path.join(tmp_dir, "out")
    with zipfile.ZipFile(signed_zip_path, "r") as zf:
        zf.extractall(extract_dir)
        names = zf.namelist()
        print(f"    Files: {names}")

    # Find the .exe
    signed_exe = None
    for root, dirs, files_list in os.walk(extract_dir):
        for fname in files_list:
            if fname.endswith(".exe"):
                signed_exe = os.path.join(root, fname)
                break

    if not signed_exe:
        print(f"No .exe found in signed zip!")
        sys.exit(1)

    shutil.copy2(signed_exe, exe_path)
    print(f"    Replaced: {exe_path}")
    print("Done!")

finally:
    shutil.rmtree(tmp_dir, ignore_errors=True)
