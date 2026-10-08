import unittest
from unittest.mock import patch
import os
import sys

from utils.wechatutils import WechatUtils
from utils.wmpfdebugger import backend_command
import main


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.utils = WechatUtils()

    def test_new_launcher_uses_runtime_not_client_version(self):
        args = [r'C:\Users\user123\RadiumWMPF\WeChatAppEx.exe',
                '--client_version=4065599282',
                r'--flue-runtime-dir=C:\Users\user123\RadiumWMPF\25773\extracted\runtime']
        self.assertEqual(self.utils.extract_version_number(args), 25773)
        self.assertTrue(self.utils.is_wechatEx_process(args))
        self.assertFalse(self.utils.is_wechatEx_process(args + ['--type=renderer']))

    def test_quoted_runtime_with_spaces_overrides_old_path(self):
        args = [r'C:\RadiumWMPF\20089\WeChatAppEx.exe',
                r'--flue-runtime-dir="C:\User Name\RadiumWMPF\25773\extracted\runtime"']
        self.assertEqual(self.utils.extract_version_number(args), 25773)

    def test_legacy_json_and_versioned_paths(self):
        self.assertEqual(self.utils.extract_version_number(['WeChatAppEx.exe', '{"version": 11275}']), 11275)
        self.assertEqual(self.utils.extract_version_number([r'C:\WMPFRuntime\9129\WeChatAppEx.exe']), 9129)
        self.assertIsNone(self.utils.extract_version_number(['WeChatAppEx.exe', '--client_version=25773']))

    def test_child_and_unrelated_executables_are_excluded(self):
        for args in ([], ['OtherWeChatAppEx.exe'], ['WeChatAppEx.exe', '--type', 'renderer']):
            self.assertFalse(self.utils.is_wechatEx_process(args))

    @patch('utils.wmpfdebugger.shutil.which', return_value='node.exe')
    @patch('utils.wmpfdebugger.Path.is_file')
    def test_unknown_build_autodetect_and_exact_pid(self, exists, which):
        exists.side_effect = [True, False]
        command, env = backend_command(1234, 25773, debug=True)
        self.assertIn('--auto-detect', command)
        self.assertIn('--debug-frida', command)
        self.assertEqual(env['WMPF_TARGET_PID'], '1234')
        self.assertEqual(env['WMPF_TARGET_VERSION'], '25773')

    @patch('utils.wmpfdebugger.shutil.which', return_value=None)
    def test_missing_node_fails_clearly(self, which):
        with self.assertRaisesRegex(RuntimeError, 'Node.js'):
            backend_command(1234, 25773)

    @patch('main.sys.platform', 'win32')
    @patch('main.WechatUtils')
    @patch('utils.wmpfdebugger.run_backend', return_value=0)
    def test_new_version_routes_without_python_frida(self, run, utils):
        utils.return_value.get_runtime_processes.return_value = [(42, 25773)]
        with patch.object(sys, 'argv', ['main.py', '-x']):
            self.assertEqual(main.main(), 0)
        run.assert_called_once_with(42, 25773, debug=False)

    @patch('main.sys.platform', 'win32')
    @patch('main.WechatUtils')
    @patch('utils.wmpfdebugger.run_backend')
    def test_multiple_instances_require_pid(self, run, utils):
        utils.return_value.get_runtime_processes.return_value = [(42, 25773), (43, 25773)]
        with patch.object(sys, 'argv', ['main.py', '-x']):
            with self.assertRaises(SystemExit) as error:
                main.main()
        self.assertEqual(error.exception.code, 2)
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
