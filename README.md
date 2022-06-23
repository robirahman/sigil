# Sigil Online

How to run Sigil Online locally:

1. Install python3 and pip3 (the standard python3 package manager) on your machine. They may already be there; try running `which pip3`, if it returns anything then you already have python3 and pip3.  If not, `brew install python3` will install both python3 and pip3 using Homebrew on Mac. On Linux, `apt install python3-pip python3-dev build-essential libssl-dev libffi-dev python3-setuptools` should do it.

2. Clone this Github repo and `cd` into the top-level directory (where the `requirements.txt` file is).

3. Run `pip3 install -r requirements.txt`. This will install all the necessary python3 packages for running Sigil Online locally.

4. From the same directory, run `flask run`. This will launch a lightweight development version of the full Sigil Online server. It should be running at `http://127.0.0.1:5000/`.

5. Visit the above URL in a web browser.