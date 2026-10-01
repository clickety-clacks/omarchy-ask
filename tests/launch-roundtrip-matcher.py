"""Pure graph seam for Ask launch-plan replay; never collect host processes."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
from agent_window_resolver import (
    ObservationError, ProcessIdentity, ProcessNode, Resolver, StaticCollector,
    TargetObservation, TopologySnapshot, WindowObservation, parse_request,
)


def main():
    value = json.load(sys.stdin)
    request = parse_request(value["request"])
    observations = []
    for window in request.windows:
        record = value["records"][window.stable_id]
        root = ProcessIdentity(request.local_machine, window.pid, window.start_time_ticks)
        child = ProcessIdentity(request.local_machine, window.pid + 1, "101")
        observations.append(WindowObservation(window, (
            ProcessNode(root, None, tuple(record["terminalArgv"])),
            ProcessNode(child, root, tuple(record["transportArgv"])),
        )))
    target = TargetObservation(
        request.target.identity.machine, None, None, (), None, (), "unreachable",
        (ObservationError("remote_target_not_probed", "transport", "Pure replay", False),),
    )
    response = Resolver().resolve(request, StaticCollector(TopologySnapshot(tuple(observations), target)))
    print(json.dumps(response))


if __name__ == "__main__":
    main()
