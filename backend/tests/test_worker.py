"""生命周期 worker 的调度契约（A13/B3）。

回归背景：清理逻辑写在 worker.py 里，但 Dockerfile 的 CMD 只有 uvicorn、
compose 也没有第二个服务，`if __name__ == "__main__"` 永远不会被触发——
到期照片不撤销、不清除，用户点了删除也只是标记。
"""

import asyncio

import pytest

from app import worker


class TestInlineWorkerSwitch:
    def test_enabled_by_default(self, monkeypatch):
        monkeypatch.delenv("PORTRAIT_DISABLE_INLINE_WORKER", raising=False)
        assert worker.inline_worker_enabled() is True

    @pytest.mark.parametrize("value", ["1", "true"])
    def test_can_be_disabled_for_a_standalone_deployment(self, monkeypatch, value):
        monkeypatch.setenv("PORTRAIT_DISABLE_INLINE_WORKER", value)
        assert worker.inline_worker_enabled() is False


class TestLifecycleWorker:
    def test_runs_cleanup_while_the_app_is_up(self, monkeypatch):
        calls: list[int] = []
        monkeypatch.setattr(worker, "run_once", lambda: calls.append(1))

        async def scenario():
            async with worker.lifecycle_worker():
                await asyncio.sleep(0.05)

        asyncio.run(scenario())
        assert calls, "清理循环必须在应用启动后真正跑起来"

    def test_does_nothing_when_disabled(self, monkeypatch):
        calls: list[int] = []
        monkeypatch.setattr(worker, "run_once", lambda: calls.append(1))
        monkeypatch.setenv("PORTRAIT_DISABLE_INLINE_WORKER", "1")

        async def scenario():
            async with worker.lifecycle_worker():
                await asyncio.sleep(0.05)

        asyncio.run(scenario())
        assert calls == []

    def test_a_failing_sweep_does_not_take_down_the_loop(self, monkeypatch):
        calls: list[int] = []

        def boom():
            calls.append(1)
            raise RuntimeError("磁盘暂时不可用")

        monkeypatch.setattr(worker, "run_once", boom)

        async def scenario():
            async with worker.lifecycle_worker():
                await asyncio.sleep(0.05)

        asyncio.run(scenario())  # 不应抛出
        assert calls

    def test_stops_when_the_app_shuts_down(self, monkeypatch):
        monkeypatch.setattr(worker, "run_once", lambda: None)
        finished: list[str] = []

        async def scenario():
            async with worker.lifecycle_worker():
                await asyncio.sleep(0.01)
            finished.append("clean")

        asyncio.run(scenario())
        assert finished == ["clean"]
