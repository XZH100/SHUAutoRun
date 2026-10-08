import os,re,sys
import psutil,subprocess
from utils.colors import Color

class WechatUtils:
    def __init__(self):
        self.configs_path = self.get_configs_path()
        self.version_list = self.get_version_list()

        # self.pid , self.version =  self.get_wechat_pid_and_version()
        # if self.pid is None and self.version is None:
        #     self.print_process_not_found_message()

    def get_configs_path(self):
        current_path = os.path.abspath(__file__)
        relative_path = '../configs/'
        return os.path.join(os.path.dirname(current_path), relative_path)

    def get_version_list(self):
        configs_path = self.configs_path
        version_list = os.listdir(configs_path)
        versions_list = [int(file.split('_')[1]) for file in version_list if file.startswith('address_')]
        return versions_list

    def is_wechatEx_process(self, cmdline):
        return bool(cmdline and re.search(r'(?:^|[\\/])WeChatAppEx(?:\.exe)?$', cmdline[0].strip('"'), re.I)
                    and not any(arg.startswith('--type=') or arg == '--type' for arg in cmdline[1:]))

    def get_runtime_processes(self):
        """Return main runtimes, including versions without legacy offsets."""
        instances = []
        for proc in psutil.process_iter(['pid', 'cmdline']):
            try:
                cmdline = proc.info['cmdline']
                if self.is_wechatEx_process(cmdline):
                    instances.append((proc.info['pid'], self.extract_version_number(cmdline)))
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        return instances

    def has_modern_wechat(self):
        return any((p.info['name'] or '').lower() == 'weixin.exe'
                   for p in psutil.process_iter(['name']))
    def get_wechat_pids_and_versions(self):
        return [(pid, version) for pid, version in self.get_runtime_processes()
                if version in self.version_list]

    def get_wechat_pid_and_version(self):
        wechat_instances = self.get_wechat_pids_and_versions()
        return wechat_instances[0] if wechat_instances else (None, None)

    def get_wechat_pids_and_versions_mac(self):
        try:
            pid_command = "ps aux | grep 'WeChatAppEx' |  grep -v 'grep' | grep ' --client_version' | grep '-user-agent=' | awk '{print $2}'"
            version_command = "ps aux | grep 'WeChatAppEx' |  grep -v 'grep' | grep ' --client_version' | grep '-user-agent=' | grep -oE 'MacWechat/([0-9]+\.)+[0-9]+\(0x\d+\)' |  grep -oE '(0x\d+)' | sed 's/0x//g'"
            pids = subprocess.run(pid_command, shell=True, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.split()
            versions = subprocess.run(version_command, shell=True, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.split()
            return list(zip(map(int, pids), versions))
        except subprocess.CalledProcessError as e:
            print(Color.RED + f"Error getting MacOS WeChat instances: {e.stderr}" + Color.END)
            return []

    def print_process_not_found_message(self):
        print(Color.RED + "[-] 未找到匹配版本的微信进程或微信未运行" + Color.END)
    
    def find_installation_path(self, program_name):
        try:
            import winreg
            reg_path = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
            reg_key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, reg_path)

            for i in range(1024):
                try:
                    sub_key_name = winreg.EnumKey(reg_key, i)
                    sub_key = winreg.OpenKey(reg_key, sub_key_name)
                    display_name = winreg.QueryValueEx(sub_key, "DisplayName")[0]
                    # 排除企业微信 和 适配英文区域安装的WeChat
                    if program_name == display_name or display_name == 'WeChat':
                        install_location = winreg.QueryValueEx(sub_key, "InstallLocation")[0]+"\\WeChat.exe"
                        print(Color.GREEN + f"[+] 查找到{program_name}的安装路径是：{install_location}" + Color.END)
                        print(Color.GREEN + f"[+] 正在尝试重启微信..."+ Color.END)
                        return install_location
                except WindowsError:
                    pass

        except Exception as e:
            print(Color.RED + f"[-] 查找安装路径时出错：{e}"+ Color.END)
    

    def extract_version_number(self, cmdline):
        command = ' '.join(cmdline)
        # The new launcher is outside the numbered runtime directory.
        runtime_match = re.search(r'--flue-runtime-dir(?:=|\s+)(?:"[^"\r\n]*"|\S+)', command)
        if runtime_match:
            version_match = re.search(r'RadiumWMPF[\\/]+(\d+)(?:[\\/]|\b)', runtime_match.group(), re.I)
            if version_match:
                return int(version_match.group(1))
        version_match = re.search(r'"version"\s*:\s*(\d+)', command)
        if not version_match:
            version_match = re.search(r'(?:RadiumWMPF|WMPFRuntime)[\\/]+(\d+)[\\/]', cmdline[0] if cmdline else '', re.I)
        return int(version_match.group(1)) if version_match else None
    
    def get_wechat_pid_and_version(self):
        instances = self.get_wechat_pids_and_versions()
        return instances[0] if instances else (None, None)
    
    def print_process_not_found_message(self):
        print(Color.RED + "[-] 未找到匹配版本的微信进程或微信未运行" + Color.END)

    def get_wechat_pid_and_version_mac(self):
        try:
            pid_command="ps aux | grep 'WeChatAppEx' |  grep -v 'grep' | grep ' --client_version' | grep '-user-agent=' | awk '{print $2}' | tail -n 1"
            version_command = "ps aux | grep 'WeChatAppEx' |  grep -v 'grep' | grep ' --client_version' | grep '-user-agent=' | grep -oE 'MacWechat/([0-9]+\.)+[0-9]+\(0x\d+\)' |  grep -oE '(0x\d+)' | sed 's/0x//g' | head -n 1"
            pid  = subprocess.run(pid_command, shell=True, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.replace("\n","")
            version  = subprocess.run(version_command, shell=True, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.replace("\n","")
            return int(pid),version
        except subprocess.CalledProcessError as e:
            return e.stderr

