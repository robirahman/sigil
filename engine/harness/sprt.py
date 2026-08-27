"""Sequential Probability Ratio Test for Sigil arenas.

WHY. Every ordering experiment in this project so far ran 250-500 games, which is
+/-35 Elo at 95%. Two of them came back "+4 +/- 17" and "-17", i.e. measurements too
coarse to answer the question that was asked. SPRT spends games only until the
hypothesis is actually decided, so a real +40 Elo resolves in a few hundred games
while a true zero is *also* resolved instead of being reported as noise.

SIGIL HAS NO DRAWS, which makes this simpler than the chess case: each game is a
Bernoulli trial, so the log-likelihood ratio is exact rather than trinomial-approximated.

    H0: elo_diff = elo0   (default 0, "no better than baseline")
    H1: elo_diff = elo1   (default +25, "worth keeping")

    p(elo) = 1 / (1 + 10^(-elo/400))
    LLR    = wins * ln(p1/p0) + losses * ln((1-p1)/(1-p0))

Accept H1 at LLR >= ln((1-beta)/alpha); accept H0 at LLR <= ln(beta/(1-alpha)).
With alpha = beta = 0.05 the bounds are +/-2.944.

Colours are still swapped in pairs by the callers: Sigil is NOT colour-symmetric
(red needs a real lead of 4, blue 2, and blue holds the +1 token), so an unbalanced
colour split biases the result. LLR is accumulated per GAME; pairing only keeps the
colour counts equal.
"""
import math


def elo_to_p(elo):
    """Expected score for a rating advantage of `elo`, draw-free."""
    return 1.0 / (1.0 + 10.0 ** (-elo / 400.0))


def p_to_elo(p):
    if p <= 0.0 or p >= 1.0:
        return float('inf') if p >= 1.0 else float('-inf')
    return 400.0 * math.log10(p / (1.0 - p))


class Sprt:
    def __init__(self, elo0=0.0, elo1=25.0, alpha=0.05, beta=0.05):
        self.p0 = elo_to_p(elo0)
        self.p1 = elo_to_p(elo1)
        self.elo0, self.elo1 = elo0, elo1
        self.lower = math.log(beta / (1.0 - alpha))
        self.upper = math.log((1.0 - beta) / alpha)
        self.wins = 0
        self.losses = 0
        # Recorded but NOT fed to the LLR: an unfinished game is not evidence
        # either way, and counting it as half a win would bias a draw-free test.
        self.unfinished = 0

    def update(self, result):
        """`result`: True = win for the arm under test, False = loss, None = unfinished."""
        if result is None:
            self.unfinished += 1
        elif result:
            self.wins += 1
        else:
            self.losses += 1
        return self.verdict

    @property
    def n(self):
        return self.wins + self.losses

    @property
    def llr(self):
        if self.n == 0:
            return 0.0
        return (self.wins * math.log(self.p1 / self.p0)
                + self.losses * math.log((1.0 - self.p1) / (1.0 - self.p0)))

    @property
    def verdict(self):
        llr = self.llr
        if llr >= self.upper:
            return 'H1'          # the arm is worth keeping
        if llr <= self.lower:
            return 'H0'          # the arm is not better than baseline
        return 'continue'

    @property
    def score(self):
        return self.wins / self.n if self.n else 0.0

    def elo(self):
        return p_to_elo(self.score)

    def ci95(self):
        """Wald interval on the score, in Elo. Wide at small n by design."""
        n = self.n
        if n == 0:
            return (float('-inf'), float('inf'))
        p = self.score
        se = math.sqrt(max(p * (1.0 - p), 1e-12) / n)
        lo, hi = max(1e-9, p - 1.96 * se), min(1 - 1e-9, p + 1.96 * se)
        return (p_to_elo(lo), p_to_elo(hi))

    def line(self, label=""):
        lo, hi = self.ci95()
        return (f"SPRT {label} n={self.n} W-L {self.wins}-{self.losses}"
                f" unf={self.unfinished} score={100*self.score:.1f}%"
                f" elo={self.elo():+.0f} [{lo:+.0f},{hi:+.0f}]"
                f" LLR={self.llr:+.2f} ({self.lower:+.2f},{self.upper:+.2f})"
                f" -> {self.verdict}")


def replay(results, elo0=0.0, elo1=25.0):
    """Feed an iterable of True/False/None and report where SPRT would have stopped.

    Used to re-read completed campaigns: it says whether a past experiment was
    decided long before it finished, or was never decided at all.
    """
    s = Sprt(elo0, elo1)
    stop_at = None
    for r in results:
        s.update(r)
        if stop_at is None and s.verdict != 'continue':
            stop_at = (s.n, s.verdict)
    return s, stop_at
