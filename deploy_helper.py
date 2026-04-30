"""Helper script for deploy.bat - renders the Quarto site locally."""
import sys, os, shutil, subprocess, tempfile, time

PROJECT = os.path.dirname(os.path.abspath(__file__))
SKIP_DIRS = {'.git', '_site', '_freeze', '.quarto', '__pycache__'}

# Quarto 경로: 드라이브 문자가 바뀌어도 대응 (스크립트 위치 기준 상대 경로)
# 구조: (드라이브)\07_LASER\01_Homepage\01_git\kayhryu89.github.io\deploy_helper.py
#       (드라이브)\07_LASER\03_App\00_Python\Lib\quarto\bin\quarto.cmd
_DRIVE = os.path.splitdrive(PROJECT)[0]  # 예: 'E:'
QUARTO = os.path.join(_DRIVE, os.sep, '07_LASER', '03_App', '00_Python', 'Lib', 'quarto', 'bin', 'quarto.cmd')

def copy_project(dst):
    """Copy project to dst, excluding .git and build artifacts."""
    for item in os.listdir(PROJECT):
        if item in SKIP_DIRS:
            continue
        src = os.path.join(PROJECT, item)
        dest = os.path.join(dst, item)
        if os.path.isdir(src):
            shutil.copytree(src, dest)
        else:
            shutil.copy2(src, dest)

def render():
    """Render site in temp directory to avoid .git/worktrees issues."""
    build_dir = os.path.join(tempfile.gettempdir(), 'laser-build')

    # Clean previous build
    if os.path.exists(build_dir):
        shutil.rmtree(build_dir, ignore_errors=True)
    os.makedirs(build_dir, exist_ok=True)

    print('[1/5] Copying project to temp...')
    copy_project(build_dir)

    print('[2/5] Rendering site...')
    result = subprocess.run([QUARTO, 'render'], cwd=build_dir, shell=True)
    if result.returncode != 0:
        shutil.rmtree(build_dir, ignore_errors=True)
        return 1

    # Copy _site back
    site_src = os.path.join(build_dir, '_site')
    site_dst = os.path.join(PROJECT, '_site')
    if os.path.exists(site_dst):
        for attempt in range(3):
            shutil.rmtree(site_dst, ignore_errors=True)
            if not os.path.exists(site_dst):
                break
            time.sleep(1)
    os.makedirs(site_dst, exist_ok=True)
    for item in os.listdir(site_src):
        s = os.path.join(site_src, item)
        d = os.path.join(site_dst, item)
        if os.path.isdir(s):
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)
    shutil.rmtree(build_dir, ignore_errors=True)
    print('       Render complete.')
    return 0

def publish():
    """Legacy entry point kept for compatibility.

    Direct gh-pages force-push deployment is intentionally disabled. Push main
    instead; GitHub Actions validates, renders, and publishes gh-pages.
    """
    print('Direct gh-pages publishing is disabled.')
    print('Use deploy.bat, or push main and let GitHub Actions publish the site.')
    return 0

if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'render'
    if action == 'render':
        sys.exit(render())
    elif action == 'publish':
        sys.exit(publish())
