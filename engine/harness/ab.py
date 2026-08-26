import sys, os
sys.path.insert(0, os.environ['SCRATCH'])
from arena import match
a, bname, pairs, ms = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
match(a, {'ms':ms,'scale':1,'eval':a}, bname, {'ms':ms,'scale':1,'eval':bname}, pairs)
