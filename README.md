# Sigil Online

## How to run Sigil Online locally:

1. Install python3 and pip3 (the standard python3 package manager) on your machine. They may already be there; try running `which pip3`, if it returns anything then you already have python3 and pip3. If not, `brew install python3` will install both python3 and pip3 using Homebrew on Mac. On Linux, `apt install python3-pip python3-dev build-essential libssl-dev libffi-dev python3-setuptools` should do it.

2. Clone this Github repo and `cd` into the top-level directory (where the `requirements.txt` file is).

3. Run `pip3 install -r requirements.txt`. This will install all the necessary python3 packages for running Sigil Online locally.

4. From the same directory, run `flask run`. This will launch a lightweight development version of the full Sigil Online server. It should be running at `http://127.0.0.1:5000/`.

5. Visit the above URL in a web browser.

## Installing front-end dependencies

### Node

You should use the same version of Node as set in `.nvmrc`. You can run [`nvm use`](https://github.com/nvm-sh/nvm) or use [shell integration](https://github.com/nvm-sh/nvm#deeper-shell-integration) to automatically install and switch to the correct version.

Then run `npm install`.

### Linting and formatting

[Prettier](https://prettier.io/), [ESLint](https://eslint.org/) and [StyleLint](https://stylelint.io/) are used to format, find and fix errors in HTML, JS and CSS files.

Running `npm run format` will try to format and fix all files (first CSS, then HTML and JS), however, errors occurred by 1 process will prevent the others from continuing.

If you run in to errors, please correct them and re-`format`.

Alternatively, you can set up editor plugins for each to get realtime feedback on code issues.
