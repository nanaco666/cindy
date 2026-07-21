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
# zip_path is assigned once inside the try block (a fixed "sign_target.zip", to
# dodge npkg issues with special chars in exe names) and read via globals by
# upload_zip(); it isn't declared here to avoid a misleading dead assignment.
signed_zip_path = os.path.join(tmp_dir, "signed.zip")

headers = {"Authorization": f"Token {token}"}

PACKAGES_URL = "https://npkg.xindong.com/api/v1/packages/"


def upload_zip():
    """Upload the zip for signing; return the requests response."""
    with open(zip_path, "rb") as f:
        files = [("file", (os.path.basename(zip_path), f, "application/octet-stream"))]
        return requests.post(
            PACKAGES_URL,
            headers=headers,
            data={"memo": f"xdt-maker-sign-{int(time.time())}"},
            files=files,
        )


def poll_until_signed(package_id):
    """Poll a package until signing completes.

    Returns the sign_file URL on success, or None on server-side failure /
    timeout (caller decides how to fall back). Prints the concrete terminal
    reason (failed vs timed out) itself, so callers don't emit a contradictory
    second message.
    """
    for _ in range(30):
        status_resp = requests.get(f"{PACKAGES_URL}{package_id}/", headers=headers)
        status_data = status_resp.json()
        status = status_data.get("sign_status", "unknown")
        if status == "completed":
            print("    Signing completed!")
            return status_data.get("sign_file")
        if status == "failed":
            print("    Signing failed on server!")
            return None
        print(f"    {status}...")
        time.sleep(3)
    print("    Signing timed out!")
    return None


def download_and_replace(sign_file_url):
    """Download the signed zip, extract its .exe, and overwrite exe_path in place.

    Returns True on success, False on any download/extract problem.
    """
    url = "https://npkg.xindong.com" + sign_file_url
    print(f"[4] Downloading: {url}")
    res = requests.get(url, stream=True, timeout=3600)
    if res.status_code != 200:
        print(f"    Download failed: {res.status_code}")
        print(f"    Response: {res.text[:200]}")
        return False

    with open(signed_zip_path, "wb") as fp:
        for chunk in res.iter_content(chunk_size=65536):
            if chunk:
                fp.write(chunk)
    print(f"    Downloaded {os.path.getsize(signed_zip_path)} bytes")

    # 5. Extract and replace
    print("[5] Extracting...")
    extract_dir = os.path.join(tmp_dir, "out")
    with zipfile.ZipFile(signed_zip_path, "r") as zf:
        zf.extractall(extract_dir)
        print(f"    Files: {zf.namelist()}")

    signed_exe = None
    for root, _dirs, files_list in os.walk(extract_dir):
        for fname in files_list:
            if fname.endswith(".exe"):
                signed_exe = os.path.join(root, fname)
                break

    if not signed_exe:
        print("No .exe found in signed zip!")
        return False

    shutil.copy2(signed_exe, exe_path)
    print(f"    Replaced: {exe_path}")
    return True


try:
    # 1. Zip — use a simple name to avoid npkg issues with special chars
    zip_path = os.path.join(tmp_dir, "sign_target.zip")
    print(f"[1] Zipping {exe_name}...")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(exe_path, exe_name)

    # 2. Upload
    print("[2] Uploading...")
    resp = upload_zip()
    data = resp.json()

    # Handle content-hash conflict.
    #
    # npkg dedups uploads by file content, so a byte-identical exe — typically a
    # pinned third-party binary like rg.exe / adb.exe / OpenConsole.exe that never
    # changes between builds — collides with a record from an EARLIER build
    # (HTTP 409 + conflict_id). That prior record is owned by whichever build/job
    # uploaded it first, so the current job's token often CAN'T delete it; the old
    # "delete + retry once" path then just re-collides and fails the whole make.
    #
    # Since identical content => identical signature, the robust fix is to REUSE
    # the conflicting package's already-signed artifact instead of re-signing:
    #   - completed        -> download its sign_file directly (done)
    #   - still signing    -> poll it to completion, then download
    #   - failed / other   -> fall back to delete + re-upload (bounded retries,
    #                         with the DELETE status checked so we don't spin
    #                         blindly against a record we can't remove)
    retries = 0
    while resp.status_code == 409 and data.get("conflict_id") and retries < 3:
        conflict_id = data["conflict_id"]
        print(f"    Conflict (ID {conflict_id}) — inspecting existing package...")
        info = requests.get(f"{PACKAGES_URL}{conflict_id}/", headers=headers)
        info_data = info.json() if info.status_code == 200 else {}
        status = info_data.get("sign_status")

        if info.status_code == 200 and status == "completed":
            if info_data.get("sign_file"):
                print(f"    Reusing already-signed package {conflict_id}.")
                if download_and_replace(info_data["sign_file"]):
                    print("Done!")
                    sys.exit(0)
                print("    Reuse download failed — falling back to re-sign.")
            else:
                # completed but no artifact URL — nothing to reuse; go straight to fallback
                print(f"    Package {conflict_id} reports completed but has no sign_file "
                      "— falling back to re-sign.")
        elif info.status_code == 200 and status != "failed":
            print(f"    Existing package {conflict_id} still signing — polling it...")
            reuse_url = poll_until_signed(conflict_id)
            if reuse_url and download_and_replace(reuse_url):
                print("Done!")
                sys.exit(0)
            print("    Poll/download of existing package failed — falling back to re-sign.")

        # Fallback: delete the conflicting record and retry the upload.
        del_resp = requests.delete(f"{PACKAGES_URL}{conflict_id}/", headers=headers)
        if del_resp.status_code not in (200, 202, 204):
            print(
                f"    DELETE {conflict_id} not permitted (HTTP {del_resp.status_code}); "
                "cannot clear this record with the current token — re-uploading identical "
                "bytes would just collide again."
            )
            break
        print(f"    Deleted {conflict_id}, re-uploading...")
        resp = upload_zip()
        data = resp.json()
        retries += 1

    if resp.status_code not in (200, 201):
        print(f"Upload failed: {data}")
        sys.exit(1)

    package_id = data["id"]
    print(f"    Package ID: {package_id}")

    # 3. Poll
    print("[3] Waiting for signing...")
    sign_file_url = poll_until_signed(package_id)
    if not sign_file_url:
        # poll_until_signed already printed the concrete reason (failed / timed out)
        sys.exit(1)

    # 4 & 5. Download, extract, replace
    if not download_and_replace(sign_file_url):
        sys.exit(1)
    print("Done!")

finally:
    shutil.rmtree(tmp_dir, ignore_errors=True)
