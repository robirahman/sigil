"""Filters applied at training data load time.

The cutoff date for the Fireblast rule change is 2026-05-07 (the
explanation used to live in the since-deleted TRAINING.md; see git
history and 2026-10-training-plan.md): any self-play / human game whose board includes Fireblast
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


# Spells whose rules the providence-bank branch (2026-10) changes: the
# Providence pack moves from per-turn extra-move schedules to a stone bank,
# Fissure's blast also destroys the caster's stones, Bulwark also shields
# against conversion and destruction. Every record holding one of them was
# played under the OLD rules (the branch purges them from Firebase at deploy,
# ai/purge_spell_games.py), so benchmarks and training data drop them.
OCT2026_RULE_CHANGE_SPELLS = frozenset(
    {'Fissure', 'Bulwark', 'Dividend', 'Annuity', 'Endowment'})


def sfn_spell_names(sfn):
    """Base spell names in an SFN's spell list (duplicate-variant aliases such
    as 'Annuity~2' collapse to 'Annuity')."""
    if not sfn:
        return []
    head = sfn.split(' ', 1)[0]
    if '/' not in head:
        return []
    return [s.split('~')[0] for s in head.split('/', 1)[1].split(',') if s]


# The rule change went live with PR #10 (merged 2026-10-07 00:23 UTC; the
# Firebase purge of old-rule games ran right after). Records holding one of the
# spells above are old-rules only if they predate this; later ones are valid.
OCT2026_RULE_CHANGE_LIVE = datetime(2026, 10, 7, 0, 30)   # UTC
OCT2026_RULE_CHANGE_LIVE_MS = int(
    (OCT2026_RULE_CHANGE_LIVE - datetime(1970, 1, 1)).total_seconds() * 1000)


def has_oct2026_rule_change_spell(sfn):
    """True iff the SFN's draw holds a spell the 2026-10 rule change rewrote."""
    return any(s in OCT2026_RULE_CHANGE_SPELLS for s in sfn_spell_names(sfn))


def is_pre_oct2026_rule_change_record(sfn, played_ms):
    """True iff the record holds a rewritten spell AND was played before the
    change went live (`played_ms`: the game's epoch-ms timestamp). A record
    with no timestamp counts as old: the old-rule games were purged, so an
    undated one is suspect."""
    if not has_oct2026_rule_change_spell(sfn):
        return False
    if not played_ms:
        return True
    return int(played_ms) < OCT2026_RULE_CHANGE_LIVE_MS
