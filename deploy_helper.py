"""Helper script for deploy.bat - handles file operations and gh-pages push."""
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
    """Push _site to gh-pages branch without using git worktrees."""
    site_dir = os.path.join(PROJECT, '_site')
    if not os.path.exists(site_dir):
        print('ERROR: _site not found. Run render first.')
        return 1

    deploy_dir = os.path.join(tempfile.gettempdir(), 'laser-deploy')
    # Robust cleanup: kill any lingering git processes, retry rmtree
    if os.path.exists(deploy_dir):
        subprocess.run(['taskkill', '/F', '/IM', 'git.exe'], capture_output=True, shell=True)
        time.sleep(0.5)
        for attempt in range(3):
            shutil.rmtree(deploy_dir, ignore_errors=True)
            if not os.path.exists(deploy_dir):
                break
            time.sleep(1)
    # If still exists, use unique name as fallback
    if os.path.exists(deploy_dir):
        deploy_dir = os.path.join(tempfile.gettempdir(), f'laser-deploy-{int(time.time())}')
    os.makedirs(deploy_dir, exist_ok=True)
    # Copy site contents into deploy dir
    for item in os.listdir(site_dir):
        s = os.path.join(site_dir, item)
        d = os.path.join(deploy_dir, item)
        if os.path.isdir(s):
            shutil.copytree(s, d)
        else:
            shutil.copy2(s, d)

    # Get user info from main repo for the temp repo
    user_name = subprocess.run(['git', 'config', 'user.name'], cwd=PROJECT, capture_output=True, text=True, shell=True).stdout.strip() or 'deploy'
    user_email = subprocess.run(['git', 'config', 'user.email'], cwd=PROJECT, capture_output=True, text=True, shell=True).stdout.strip() or 'deploy@localhost'

    cmds = [
        ['git', 'init', '-b', 'gh-pages'],
        ['git', 'config', 'user.name', user_name],
        ['git', 'config', 'user.email', user_email],
        ['git', 'add', '.'],
        ['git', 'commit', '-m', 'Built site for gh-pages'],
        ['git', 'remote', 'add', 'origin', 'https://github.com/kayhryu89/kayhryu89.github.io.git'],
        ['git', 'push', '--force', 'origin', 'gh-pages'],
    ]
    for cmd in cmds:
        show = cmd[1] in ('push', 'commit')
        r = subprocess.run(cmd, cwd=deploy_dir, capture_output=not show, shell=True)
        if r.returncode != 0 and cmd[1] == 'init':
            # Fallback for older git without -b flag
            subprocess.run(['git', 'init'], cwd=deploy_dir, capture_output=True, shell=True)
            subprocess.run(['git', 'checkout', '-b', 'gh-pages'], cwd=deploy_dir, capture_output=True, shell=True)

    shutil.rmtree(deploy_dir, ignore_errors=True)
    return 0

if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'render'
    if action == 'render':
        sys.exit(render())
    elif action == 'publish':
        sys.exit(publish())
