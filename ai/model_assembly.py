"""Auto-reassembly for split model checkpoints.

GitHub blocks individual files larger than 100 MB on regular pushes.
Big checkpoints are committed split (`<stem>_part_aa`, `<stem>_part_ab`,
…) following the same convention used for split JSONL training data
(`gen1_all_part_aa`, etc.). On first import, this module reassembles
the original file from its parts if the original is missing.

The helper is no-op when the assembled file already exists, so it's
safe to call eagerly at module import time and cheap on subsequent
runs. Parts are kept on disk after assembly.
"""

import glob
import os
import shutil


def ensure_assembled(target_path):
    """If `target_path` is missing but split parts exist, concatenate them.

    Looks for `<stem>_part_??` siblings (where `stem` is `target_path`
    minus its extension). Returns True if a reassembly happened, False
    if either nothing to do (file already present) or no parts found.
    """
    if os.path.exists(target_path):
        return False
    stem, _ = os.path.splitext(target_path)
    parts = sorted(glob.glob(stem + "_part_??"))
    if not parts:
        return False
    tmp = target_path + ".reassembling"
    try:
        with open(tmp, "wb") as out:
            for p in parts:
                with open(p, "rb") as f:
                    shutil.copyfileobj(f, out, length=1024 * 1024)
        os.replace(tmp, target_path)
    except Exception:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        raise
    print(f"[model_assembly] reassembled {target_path} "
          f"from {len(parts)} part(s)", flush=True)
    return True
