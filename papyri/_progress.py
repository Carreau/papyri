"""Progress-bar helpers.

Two shapes for two consumers:

- ``progress_class(dummy=...)`` returns a Progress *class* (rich's, or a
  no-op ``DummyProgress``). Use when you want to drive
  ``add_task`` / ``advance`` / ``update`` yourself, e.g.::

      with progress_class(dummy=cfg.dummy_progress)(...) as p:
          task = p.add_task("...", total=N)
          ...

- ``iter_with_progress(iterable, dummy=...)`` is a generator that yields
  ``(progress, item)`` pairs. Use when the loop body just needs the
  current progress to update its own description.
"""

from __future__ import annotations

import time
from collections.abc import Iterable, Iterator
from datetime import timedelta
from typing import Any

from rich.progress import (
    BarColumn,
    Progress,
    ProgressColumn,
    Task,
    TextColumn,
)
from rich.text import Text


class TimeElapsedColumn(ProgressColumn):
    """Elapsed time + smoothed predicted-finish display."""

    # Only refresh twice a second to prevent jitter
    max_refresh = 0.5

    def __init__(self, *args, **kwargs):
        self.avg = None
        super().__init__(*args, **kwargs)

    def render(self, task: Task):
        elapsed = task.elapsed
        if elapsed is None:
            return Text("-:--:--", style="progress.elapsed")
        elapsed_delta = timedelta(seconds=int(elapsed))
        if task.time_remaining is not None:
            if self.avg is None:
                self.avg = elapsed_delta + timedelta(seconds=int(task.time_remaining))
            else:
                self.avg = (
                    99 * self.avg
                    + elapsed_delta
                    + timedelta(seconds=int(task.time_remaining))
                ) / 100
            finish_delta = str(
                elapsed_delta + timedelta(seconds=int(task.time_remaining))
            )
        else:
            finish_delta = "--:--:--"
        return Text(
            str(elapsed_delta) + "/" + str(finish_delta), style="progress.elapsed"
        )


class DummyProgress(Progress):
    """No-op Progress.

    Rich's live display can corrupt ipdb's terminal state, so callers in
    debug / CI contexts swap this in.  Construction succeeds (so column
    args still validate) but ``add_task`` / ``advance`` / ``update`` do
    nothing and the context-manager hooks skip the live-display setup.
    """

    def add_task(self, *args, **kwargs):  # type: ignore[override,unused-ignore]
        return 0

    def advance(self, *args, **kwargs):  # type: ignore[override,unused-ignore]
        pass

    def update(self, *args, **kwargs):  # type: ignore[override,unused-ignore]
        pass

    def __enter__(self, *args, **kwargs):
        return self

    def __exit__(self, *args, **kwargs):
        pass


def progress_class(*, dummy: bool) -> type[Progress]:
    """Return ``DummyProgress`` when ``dummy``, else rich's ``Progress``."""
    return DummyProgress if dummy else Progress


def iter_with_progress(
    iterable: Iterable[Any],
    *,
    dummy: bool,
    description: str = "Progress",
    transient: bool = True,
) -> Iterator[tuple[Progress | None, Any]]:
    """Iterate ``iterable`` and yield ``(progress, item)`` pairs.

    With ``dummy=True``, no progress bar is shown; ``progress`` is
    ``None`` for every yielded pair. A one-line summary prints at the
    end if ``transient`` is set.
    """
    items = list(iterable)
    now = time.monotonic()
    n = len(items)

    def _summary() -> None:
        deltat = time.monotonic() - now
        print(
            description,
            f"Done {n: 4d} items in {deltat:.2f} seconds ({int(n / deltat): 4d} item/s)",
        )

    if dummy:
        for item in items:
            yield None, item
        if transient:
            _summary()
        return

    p = Progress(
        TextColumn("[progress.description]{task.description:15}", justify="left"),
        BarColumn(bar_width=None),
        "[progress.percentage]{task.completed}/{task.total}",
        TimeElapsedColumn(),
        transient=transient,
    )
    p.start()
    task = p.add_task(description, total=n, ee=0)
    try:
        for item in items:
            p.update(task, ee=time.monotonic() - now)
            p.advance(task)
            yield p, item
    finally:
        p.stop()
    if transient:
        _summary()
