"""Control-flow regressions, with ROS, numerical and hardware dependencies stubbed.

Run with: python3 -m unittest discover -s tests -v
These tests never connect to the robot or model server.
"""
import importlib.util
import io
from pathlib import Path
import threading
import time
from collections import deque
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from urllib.parse import urlencode


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path, stubs):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict('sys.modules', stubs):
        spec.loader.exec_module(module)
    return module


deps = {name: MagicMock() for name in (
    'cv2', 'pynput', 'requests', 'requests.adapters', 'urllib3', 'urllib3.util',
    'urllib3.util.retry', 'numpy', 'scipy', 'scipy.spatial', 'scipy.spatial.transform',
    'rclpy', 'rclpy.node', 'rclpy.callback_groups', 'rclpy.executors', 'rclpy.qos',
    'sensor_msgs', 'sensor_msgs.msg', 'geometry_msgs', 'geometry_msgs.msg',
    'std_msgs', 'std_msgs.msg', 'std_srvs', 'std_srvs.srv', 'cv_bridge',
    'model_interface.geometry', 'model_interface.utils.websocket_client',
)}
deps['rclpy.node'].Node = object
deps['std_msgs.msg'].String = SimpleNamespace
node_module = load_module(
    'model_interface.model_interface_node',
    'src/model_interface/model_interface/model_interface_node.py', deps,
)
server = load_module('interaction_server', 'assets/host_interaction/server.py',
                     {'requests': MagicMock()})
State = node_module.SystemState


def make_node(state=State.RUNNING):
    node = node_module.ModelInterfaceNode.__new__(node_module.ModelInterfaceNode)
    node.action_timer_lock = threading.RLock()
    node.commander_lock = threading.Lock()
    node.inference_lock = threading.Lock()
    node.infer_event = threading.Event()
    node.state = state
    node.current_instr = 'old task'
    node.episode_generation = 0
    node.commander_generation = 0
    node.commander_mode = 'model'
    node.bootstrap_inference = False
    node.action_queue = deque([{'raw': 'old action'}])
    node.action_queue_copy = list(node.action_queue)
    node.get_logger = MagicMock()
    node.pub_instruction = MagicMock()
    node.pub_commander = MagicMock()
    node._publish_hold_action_from_latest_state = MagicMock()
    node._clear_reset_buffers = MagicMock()
    node.debug_code = False
    node.act_len, node.act_rtc_len, node.act_mode = 2, 1, 'absolute'
    node.policy_client = MagicMock()
    node.calc_tcp_to_arm_base = MagicMock()
    node.calc_keypoints_to_hand_base = MagicMock()
    node.prepare_inference_payload = MagicMock(return_value={'states': [MagicMock()]})
    return node


class InstructionTests(unittest.TestCase):
    def test_initial_instruction_and_ready_replacement_do_not_start_robot(self):
        node = make_node(State.IDLE)
        self.assertTrue(node.update_instruction('  first task  ', 0))
        self.assertEqual(node.state, State.READY)
        node.update_instruction('second task', 0)
        self.assertEqual(node.state, State.READY)
        self.assertFalse(node.infer_event.is_set())
        node._publish_hold_action_from_latest_state.assert_not_called()

    def test_running_replacement_flushes_actions_and_holds(self):
        node = make_node()
        node.update_instruction('new task', 0)
        self.assertEqual(node.state, State.RUNNING)
        self.assertEqual(node.current_instr, 'new task')
        self.assertFalse(node.action_queue)
        self.assertEqual(node.action_queue_copy, [])
        self.assertTrue(node.bootstrap_inference)
        self.assertTrue(node.infer_event.is_set())
        node._publish_hold_action_from_latest_state.assert_called_once()
        self.assertEqual(node.pub_instruction.publish.call_args.args[0].data, 'new task')

    def test_invalid_and_duplicate_instructions_do_not_interrupt(self):
        node = make_node()
        for instruction in (None, '', '  ', 123):
            self.assertFalse(node.update_instruction(instruction, 0))
        self.assertTrue(node.update_instruction('old task', 0))
        self.assertEqual(node.commander_generation, 0)
        self.assertEqual(len(node.action_queue), 1)

    def test_human_control_is_preserved_until_explicit_resume(self):
        node = make_node()
        node.commander_mode = 'human'
        node.update_instruction('new task', 0)
        self.assertEqual(node.commander_mode, 'human')
        self.assertFalse(node.infer_event.is_set())
        node._publish_hold_action_from_latest_state.assert_not_called()
        node._transition_commander('model', bootstrap=True)
        self.assertTrue(node.infer_event.is_set())
        self.assertTrue(node.bootstrap_inference)
        self.assertEqual(node.current_instr, 'new task')

    def test_first_observation_can_be_replaced_before_sensor_data_arrives(self):
        node = make_node(State.FIRST_OBS)
        node._publish_hold_action_from_latest_state.side_effect = AssertionError('no data')
        self.assertTrue(node.update_instruction('new task', 0))
        self.assertEqual(node.state, State.FIRST_OBS)
        self.assertTrue(node.infer_event.is_set())

    def test_reset_invalidates_old_http_response_without_waiting_for_inference(self):
        node = make_node()
        with node.inference_lock:
            node._switch_state(State.RESETTING)
        self.assertFalse(node.infer_event.is_set())
        self.assertFalse(node.update_instruction('late command', 0))
        node._switch_state(State.IDLE)
        self.assertFalse(node.update_instruction('late command', 0))
        self.assertEqual(node.state, State.IDLE)
        self.assertTrue(node.update_instruction('next episode', 1))
        self.assertEqual(node.state, State.READY)

    def test_inflight_result_is_discarded_and_latest_instruction_runs_next(self):
        node = make_node()
        node.infer_event.set()
        started, release = threading.Event(), threading.Event()
        received = []

        def prepare(instruction, bootstrap, first, queue):
            received.append((instruction, bootstrap, queue))
            return {'states': [MagicMock()]}

        def infer(payload):
            if len(received) == 1:
                started.set()
                if not release.wait(2):
                    raise RuntimeError('test inference was not released')
            predictions = MagicMock()
            predictions.shape = (8, 48)
            return {'pred_actions': predictions}

        node.prepare_inference_payload.side_effect = prepare
        node.policy_client.infer.side_effect = infer
        with patch.object(node_module.rclpy, 'ok', side_effect=[True, True, False]), \
                patch.object(node_module, 'matrix_from_6d_rot', return_value=MagicMock()):
            worker = threading.Thread(target=node.inference_worker, daemon=True)
            worker.start()
            try:
                self.assertTrue(started.wait(2))
                node.update_instruction('intermediate task', 0)
                node.update_instruction('latest task', 0)
                node.control_timer_cb()
                self.assertFalse(node.action_queue)
            finally:
                release.set()
                worker.join(2)
            self.assertFalse(worker.is_alive(), 'new instruction wakeup was lost')
        self.assertEqual([entry[0] for entry in received], ['old task', 'latest task'])
        self.assertEqual(received[1][1:], (True, []))
        self.assertEqual(len(node.action_queue), node.act_len + node.act_rtc_len)
        # Only the second inference was converted into executable actions.
        self.assertEqual(node.calc_tcp_to_arm_base.call_count, 2 * len(node.action_queue))
        self.assertFalse(node.bootstrap_inference)

    def test_instruction_arriving_during_action_conversion_blocks_commit(self):
        node = make_node()
        node.infer_event.set()
        predictions = MagicMock()
        predictions.shape = (8, 48)
        node.policy_client.infer.return_value = {'pred_actions': predictions}

        def convert(*args):
            node.update_instruction('new task', 0)
            return MagicMock()

        node.calc_tcp_to_arm_base.side_effect = convert
        with patch.object(node_module.rclpy, 'ok', side_effect=[True, False]), \
                patch.object(node_module, 'matrix_from_6d_rot', return_value=MagicMock()):
            node.inference_worker()
        self.assertFalse(node.action_queue)
        self.assertTrue(node.infer_event.is_set())
        self.assertTrue(node.bootstrap_inference)

    def test_empty_queue_retries_without_old_rtc_prefix(self):
        node = make_node()
        node.action_queue.clear()
        node.control_timer_cb()
        self.assertTrue(node.infer_event.is_set())
        self.assertTrue(node.bootstrap_inference)
        self.assertEqual(node.action_queue_copy, [])

    def test_remote_loop_keeps_receiving_while_running(self):
        node = make_node()
        node.ui_host, node.ui_port = 'localhost', 8081
        node.ui_session = MagicMock()
        node.ui_session.get.return_value.json.side_effect = [
            {'instruction': 'turn left'}, {'instruction': None}, {'instruction': 'turn right'},
        ]
        with patch.object(node_module.rclpy, 'ok', side_effect=[True, True, True, False]):
            node.remote_input_loop()
        self.assertEqual(node.state, State.RUNNING)
        self.assertEqual(node.current_instr, 'turn right')
        self.assertEqual(node.ui_session.get.call_count, 3)
        self.assertEqual(node.commander_generation, 2)

    def test_reset_clears_real_buffers(self):
        node = make_node()
        del node._clear_reset_buffers
        node.buf_rgb = {'head': deque([(1, 'image')])}
        node.buf_depth = {}
        node.rgb_cb_locks = {'head': threading.Lock()}
        node.depth_cb_locks = {}
        for side in ('l', 'r'):
            setattr(node, f'{side}_pose_cb_lock', threading.Lock())
            setattr(node, f'{side}_kp_cb_lock', threading.Lock())
            setattr(node, f'buf_{side}_wrist', deque([(1, 'pose')]))
            setattr(node, f'buf_{side}_kps', deque([(1, 'keypoints')]))
        with node.inference_lock:
            node._switch_state(State.RESETTING)
        self.assertFalse(node.action_queue)
        self.assertFalse(node.buf_rgb['head'])
        for side in ('l', 'r'):
            self.assertFalse(getattr(node, f'buf_{side}_wrist'))
            self.assertFalse(getattr(node, f'buf_{side}_kps'))


class HostInputTests(unittest.TestCase):
    def setUp(self):
        self.temp_state = server.GlobalState()
        self.temp_state.save_command = MagicMock()
        self.state_patch = patch.object(server, 'state', self.temp_state)
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)

    def handler(self, instruction=None):
        handler = server.InteractionHandler.__new__(server.InteractionHandler)
        handler._send_json = MagicMock()
        body = urlencode({'instruction': instruction}).encode() if instruction is not None else b''
        handler.headers = {'Content-Length': str(len(body))}
        handler.rfile = io.BytesIO(body)
        return handler

    def start_poll(self):
        handler = self.handler()
        worker = threading.Thread(target=handler._handle_robot_request, daemon=True)
        worker.start()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            with self.temp_state.command_condition:
                if self.temp_state.is_robot_waiting:
                    return handler, worker
            time.sleep(0.001)
        self.fail('input poll did not start')

    def test_repeated_commands_on_consecutive_polls(self):
        for instruction in ('first task', 'change direction', 'third task'):
            receiver, worker = self.start_poll()
            sender = self.handler(instruction)
            sender._handle_web_submit()
            worker.join(2)
            self.assertFalse(worker.is_alive())
            sender._send_json.assert_called_once_with({'accepted': True})
            receiver._send_json.assert_called_once_with({'instruction': instruction})
            self.assertFalse(self.temp_state.is_robot_waiting)
            self.assertIsNone(self.temp_state.current_command)

    def test_duplicate_consumer_does_not_steal_command(self):
        receiver, worker = self.start_poll()
        duplicate = self.handler()
        duplicate._handle_robot_request()
        self.assertEqual(duplicate._send_json.call_args.args[1], 409)
        self.handler('new task')._handle_web_submit()
        worker.join(2)
        receiver._send_json.assert_called_once_with({'instruction': 'new task'})

    def test_idle_and_empty_submissions_are_rejected(self):
        for instruction, status in (('new task', 409), ('  ', 400)):
            sender = self.handler(instruction)
            sender._handle_web_submit()
            self.assertEqual(sender._send_json.call_args.args[1], status)

    def test_timed_out_poll_releases_waiting_state(self):
        receiver, worker = self.start_poll()
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertFalse(self.temp_state.is_robot_waiting)
        receiver._send_json.assert_called_once_with({'instruction': None})


if __name__ == '__main__':
    unittest.main()
