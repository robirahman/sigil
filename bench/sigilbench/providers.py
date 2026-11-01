"""Model adapters. Each `solve(system, user)` returns a dict:

    {"actions": list | None, "raw_answer": <tool input as received>,
     "stop": <why it ended>, "usage": {...}, "transcript": [...], "error": str | None}

Rules shared by every adapter (they define the benchmark protocol):
  * one tool, `submit_answer`; the model may reason as long as its budget
    allows, then must call it; the FIRST call is final (no feedback, no retry);
  * ONE response per puzzle: if it ends without the call (including at the
    output-token cap), that is no answer (scored wrong). There is no
    reminder: a reminder after a capped response hands the model a second
    full budget, which some models need and others don't (removed 2026-10-31);
  * no fallback to another model on refusal (a refusal is no answer) --
    the score must be one model's;
  * nothing is stored provider-side where the API allows choosing
    (OpenAI `store=False`, Gemini default); accounts must additionally be
    opted out of training and retention (bench/providers_approved.json).
API errors are retried by the SDKs (rate limits, 5xx, connection); a request
that still fails is recorded as an error and the puzzle can be re-run with
--resume.
"""
import json
import random
import subprocess

from .prompt import TOOL_DESCRIPTION, TOOL_NAME, TOOL_SCHEMA


def _parse_actions(inp):
    """Tool input -> action list (accepts a JSON string for `actions` too)."""
    if isinstance(inp, str):
        try:
            inp = json.loads(inp)
        except Exception:
            return None
    if not isinstance(inp, dict):
        return None
    a = inp.get('actions')
    if isinstance(a, str):
        try:
            a = json.loads(a)
        except Exception:
            return None
    return a if isinstance(a, list) else None


def _jsonable(x):
    if hasattr(x, 'model_dump'):
        return x.model_dump(mode='json', exclude_none=True)
    if hasattr(x, 'to_dict'):
        return x.to_dict()
    return x


class Anthropic:
    """Claude via the official SDK, streaming, adaptive thinking, effort."""
    name = 'anthropic'

    def __init__(self, model, effort='high', max_tokens=128000, **_):
        import anthropic
        self.client = anthropic.Anthropic(max_retries=6, timeout=3600)
        self.model, self.effort, self.max_tokens = model, effort, max_tokens
        self.settings = {'effort': effort, 'max_tokens': max_tokens, 'thinking': 'adaptive (display summarized)'}

    def solve(self, system, user):
        tools = [{'name': TOOL_NAME, 'description': TOOL_DESCRIPTION, 'input_schema': TOOL_SCHEMA}]
        messages = [{'role': 'user', 'content': user}]
        usage, transcript = {'input_tokens': 0, 'output_tokens': 0}, []
        for _ in range(1):   # one response per puzzle, no reminder
            # Cache breakpoint on the system prompt: it is identical for every puzzle.
            sys_blocks = [{'type': 'text', 'text': system, 'cache_control': {'type': 'ephemeral'}}]
            kw = dict(model=self.model, max_tokens=self.max_tokens, system=sys_blocks, messages=messages,
                      tools=tools, tool_choice={'type': 'auto'},
                      thinking={'type': 'adaptive', 'display': 'summarized'})
            if self.effort:
                kw['output_config'] = {'effort': self.effort}
            with self.client.messages.stream(**kw) as stream:
                msg = stream.get_final_message()
            usage['input_tokens'] += msg.usage.input_tokens
            usage['output_tokens'] += msg.usage.output_tokens
            for k in ('cache_read_input_tokens', 'cache_creation_input_tokens'):
                usage[k] = usage.get(k, 0) + (getattr(msg.usage, k, 0) or 0)
            content = [_jsonable(b) for b in msg.content]
            transcript.append({'role': 'assistant', 'stop_reason': msg.stop_reason, 'content': content})
            for b in msg.content:
                if b.type == 'tool_use' and b.name == TOOL_NAME:
                    return {'actions': _parse_actions(b.input), 'raw_answer': _jsonable(b.input),
                            'stop': 'answered', 'usage': usage, 'transcript': transcript}
            if msg.stop_reason == 'refusal':
                return {'actions': None, 'raw_answer': None, 'stop': 'refusal', 'usage': usage,
                        'transcript': transcript}
        return {'actions': None, 'raw_answer': None, 'stop': f'no tool call ({msg.stop_reason})',
                'usage': usage, 'transcript': transcript}


class OpenAI:
    """OpenAI Responses API (store=False), function tool, reasoning effort."""
    name = 'openai'

    def __init__(self, model, effort='high', max_tokens=100000, base_url=None, api_key_env=None, **_):
        import os
        import openai
        kw = {'max_retries': 6, 'timeout': 3600}
        if base_url:
            kw['base_url'] = base_url
        if api_key_env:
            kw['api_key'] = os.environ[api_key_env]
        self.client = openai.OpenAI(**kw)
        self.model, self.effort, self.max_tokens = model, effort, max_tokens
        self.settings = {'effort': effort, 'max_output_tokens': max_tokens, 'store': False}

    def solve(self, system, user):
        tools = [{'type': 'function', 'name': TOOL_NAME, 'description': TOOL_DESCRIPTION,
                  'parameters': TOOL_SCHEMA}]
        inp = [{'role': 'user', 'content': user}]
        usage, transcript = {'input_tokens': 0, 'output_tokens': 0}, []
        for _ in range(1):   # one response per puzzle, no reminder
            kw = dict(model=self.model, instructions=system, input=inp, tools=tools, tool_choice='auto',
                      store=False, max_output_tokens=self.max_tokens,
                      include=['reasoning.encrypted_content'])
            if self.effort:
                kw['reasoning'] = {'effort': self.effort, 'summary': 'auto'}
            r = self.client.responses.create(**kw)
            if r.usage:
                usage['input_tokens'] += r.usage.input_tokens
                usage['output_tokens'] += r.usage.output_tokens
            out = [_jsonable(x) for x in r.output]
            transcript.append({'role': 'assistant', 'status': r.status, 'output': out})
            for x in r.output:
                if getattr(x, 'type', None) == 'function_call' and x.name == TOOL_NAME:
                    return {'actions': _parse_actions(x.arguments), 'raw_answer': x.arguments,
                            'stop': 'answered', 'usage': usage, 'transcript': transcript}
        return {'actions': None, 'raw_answer': None, 'stop': f'no tool call ({r.status})',
                'usage': usage, 'transcript': transcript}


class XAI:
    """xAI (Grok) through its OpenAI-compatible Chat Completions endpoint."""
    name = 'xai'

    def __init__(self, model, effort=None, max_tokens=100000, **_):
        import os
        import openai
        self.client = openai.OpenAI(base_url='https://api.x.ai/v1', api_key=os.environ['XAI_API_KEY'],
                                    max_retries=6, timeout=3600)
        self.model, self.effort, self.max_tokens = model, effort, max_tokens
        self.settings = {'reasoning_effort': effort, 'max_tokens': max_tokens}

    def solve(self, system, user):
        tools = [{'type': 'function', 'function': {'name': TOOL_NAME, 'description': TOOL_DESCRIPTION,
                                                   'parameters': TOOL_SCHEMA}}]
        msgs = [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]
        usage, transcript = {'input_tokens': 0, 'output_tokens': 0}, []
        for _ in range(1):   # one response per puzzle, no reminder
            kw = dict(model=self.model, messages=msgs, tools=tools, tool_choice='auto', max_tokens=self.max_tokens)
            if self.effort:
                kw['reasoning_effort'] = self.effort
            r = self.client.chat.completions.create(**kw)
            if r.usage:
                usage['input_tokens'] += r.usage.prompt_tokens
                usage['output_tokens'] += r.usage.completion_tokens
            m = r.choices[0].message
            transcript.append({'role': 'assistant', 'finish_reason': r.choices[0].finish_reason, 'message': _jsonable(m)})
            for tc in (m.tool_calls or []):
                if tc.function.name == TOOL_NAME:
                    return {'actions': _parse_actions(tc.function.arguments), 'raw_answer': tc.function.arguments,
                            'stop': 'answered', 'usage': usage, 'transcript': transcript}
        return {'actions': None, 'raw_answer': None, 'stop': f'no tool call ({r.choices[0].finish_reason})',
                'usage': usage, 'transcript': transcript}


class Gemini:
    """Google Gemini via google-genai; automatic function calling disabled."""
    name = 'gemini'

    def __init__(self, model, effort=None, max_tokens=65536, thinking_budget=-1, **_):
        from google import genai
        self.genai = genai
        self.client = genai.Client()
        self.model, self.max_tokens, self.thinking_budget = model, max_tokens, thinking_budget
        self.effort = effort
        self.settings = {'max_output_tokens': max_tokens, 'thinking_budget': thinking_budget,
                         'thinking_level': effort}

    def solve(self, system, user):
        from google.genai import types
        tc = {'include_thoughts': True}
        if self.effort:
            tc['thinking_level'] = self.effort
        else:
            tc['thinking_budget'] = self.thinking_budget
        cfg = types.GenerateContentConfig(
            system_instruction=system, max_output_tokens=self.max_tokens,
            tools=[types.Tool(function_declarations=[types.FunctionDeclaration(
                name=TOOL_NAME, description=TOOL_DESCRIPTION, parameters_json_schema=TOOL_SCHEMA)])],
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            thinking_config=types.ThinkingConfig(**tc))
        contents = [types.Content(role='user', parts=[types.Part(text=user)])]
        usage, transcript = {'input_tokens': 0, 'output_tokens': 0}, []
        for _ in range(1):   # one response per puzzle, no reminder
            r = self.client.models.generate_content(model=self.model, contents=contents, config=cfg)
            um = r.usage_metadata
            if um:
                usage['input_tokens'] += um.prompt_token_count or 0
                usage['output_tokens'] += (um.candidates_token_count or 0) + (um.thoughts_token_count or 0)
            cand = r.candidates[0] if r.candidates else None
            transcript.append({'role': 'model', 'response': _jsonable(r)})
            parts = (cand.content.parts if cand and cand.content and cand.content.parts else [])
            for p in parts:
                if p.function_call and p.function_call.name == TOOL_NAME:
                    return {'actions': _parse_actions(dict(p.function_call.args or {})),
                            'raw_answer': _jsonable(p.function_call.args), 'stop': 'answered',
                            'usage': usage, 'transcript': transcript}
        fr = getattr(cand, 'finish_reason', None) if cand else None
        return {'actions': None, 'raw_answer': None, 'stop': f'no tool call ({getattr(fr, "name", fr)})',
                'usage': usage, 'transcript': transcript}


class Oracle:
    """Pipeline self-test: submits the stored reference solution (should score 100%)."""
    name = 'oracle'
    settings = {}

    def __init__(self, model='reference', **_):
        self.model = model

    def solve(self, system, user, puzzle=None):
        return {'actions': puzzle['reference_solution'], 'raw_answer': None, 'stop': 'answered',
                'usage': {}, 'transcript': []}


class RandomLegal:
    """Baseline: a uniformly random legal turn (one per distinct resulting
    position), from engine/examples/children.rs."""
    name = 'random'

    def __init__(self, model='uniform', seed=0, children_bin=None, **_):
        import os
        from .grader import DEFAULT_GRADE_BIN
        self.bin = children_bin or os.path.join(os.path.dirname(DEFAULT_GRADE_BIN), 'children')
        self.model, self.seed = model, seed
        self.settings = {'seed': seed}

    def solve(self, system, user, puzzle=None):
        out = subprocess.run([self.bin], input=puzzle['sfn'] + '\n', capture_output=True, text=True, check=True)
        kids = json.loads(out.stdout)['children']
        rng = random.Random(f"{self.seed}:{puzzle['id']}")
        return {'actions': json.loads(json.dumps(rng.choice(kids)['actions'])), 'raw_answer': None,
                'stop': 'answered', 'usage': {}, 'transcript': [], 'n_legal_positions': len(kids)}


PROVIDERS = {c.name: c for c in (Anthropic, OpenAI, XAI, Gemini, Oracle, RandomLegal)}
OFFLINE = {'oracle', 'random'}
