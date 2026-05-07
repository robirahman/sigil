"""Filters applied at training data load time.

The cutoff date for the Fireblast rule change is 2026-05-07. See
TRAINING.md ("Rule changes and training-data hygiene") for the full
explanation: any self-play / human game whose board includes Fireblast
and was played before that date encodes the OLD (un-nerfed) value of
the spell, and training the network on those positions teaches it the
wrong cost-benefit for casting Fireblast.
"""

import os
import re
from datetime import date, datetime


# Day the latest-edition Fireblast nerf landed (sacrifice cost added).
# Games whose board contained Fireblast and were played BEFORE this
# date are excluded from training. Boards without Fireblast are
# unaffected by the rule change and remain valid regardless of date.
FIREBLAST_RULE_CHANGE_CUTOFF = date(2026, 5, 7)

# Day the off-by-one in the Competitive variant's opening-pass gate
# was fixed. Before this date, blue's opening-blink turn could trip
# the immediate-loss rule against a player legitimately at zero
# stones, producing 1- or 2-turn "wins" that don't reflect real play.
# Any competitive-variant record written before this date is
# excluded from training.
COMPETITIVE_FIX_CUTOFF = date(2026, 5, 8)


_FILENAME_DATE_RE = re.compile(r'(\d{4})-(\d{2})-(\d{2})')


def file_effective_date(path):
    """Best-effort date for when the data in `path` was generated.

    First tries to parse YYYY-MM-DD from the filename (matches the
    convention used by selfplay generators that bake the date into the
    name, e.g. ``selfplay_v22b_2026-05-03.jsonl``). Falls back to the
    file's mtime as a date. Returns None if neither works.
    """
    m = _FILENAME_DATE_RE.search(os.path.basename(path))
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            pass
    try:
        return datetime.fromtimestamp(os.path.getmtime(path)).date()
    except OSError:
        return None


def sfn_has_fireblast(sfn):
    """True if the SFN string's spell list contains 'Fireblast'."""
    if not sfn:
        return False
    # SFN: <stones>/<spell1>,<spell2>,... <turn> <tc> ...
    try:
        spells_part = sfn.split(' ', 1)[0].split('/', 1)[1]
    except (IndexError, AttributeError):
        return False
    return 'Fireblast' in spells_part.split(',')


def sfn_variant(sfn):
    """Return the variant token from an SFN string, defaulting to
    'standard' for legacy strings that don't include the optional
    trailing token. Mirrors notation.sfn_to_dict but is cheap (just
    inspects the last whitespace-separated field)."""
    if not sfn:
        return 'standard'
    parts = sfn.strip().split(' ')
    if len(parts) > 7:
        return parts[7] or 'standard'
    return 'standard'


def is_pre_cutoff_fireblast_record(path, sfn,
                                   cutoff=FIREBLAST_RULE_CHANGE_CUTOFF):
    """Return True iff this record should be skipped due to the
    Fireblast rule change. The record is skipped when:

      - The board's spell list contains 'Fireblast', AND
      - The data file's effective date is strictly before ``cutoff``.

    Boards without Fireblast are unaffected and never skipped, even
    if the file is old. If the file's date can't be determined, the
    record is kept (we err on the side of using the data — false
    positives would silently shrink the training corpus).
    """
    if not sfn_has_fireblast(sfn):
        return False
    file_date = file_effective_date(path)
    if file_date is None:
        return False
    return file_date < cutoff


def is_pre_competitive_fix_record(path, sfn,
                                  cutoff=COMPETITIVE_FIX_CUTOFF):
    """Return True iff this record should be skipped because it was
    generated under the buggy Competitive variant (off-by-one in the
    opening-pass gate). The record is skipped when:

      - The SFN's variant token is 'competitive', AND
      - The data file's effective date is strictly before ``cutoff``.

    Standard-variant records are unaffected. Records whose date can't
    be determined are kept (same conservative default as the Fireblast
    filter).
    """
    if sfn_variant(sfn) != 'competitive':
        return False
    file_date = file_effective_date(path)
    if file_date is None:
        return False
    return file_date < cutoff
