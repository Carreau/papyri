"""

Examples Modules Heading 1
==========================

This module contains examples, none of the functions, classes or other attribute
should have any effects when called. Paragraphs should be able to contain plain
`links <https://github.com/jupyter/papyri>`__, or link via directives: :any:`papyri`

Heading 2
---------

link to :ref:`numpy.sin` , `numpy:sin` `numpy.linspace`

Heading 3
~~~~~~~~~

heading 4
.........


FieldList
---------

In my understanding FieldList should in general not happen in the final
Documents, they are supposed to be processed by the software reading them, and
typically appear at the beginning of directive.


:fieldlistitem:
    at least that the name tree sitter rst give it.
:another: is another fieldlistItem in this field list
    and it's description


Enumeration and unordered lists
-------------------------------

Enumeration list.

1. item 1
2. item 2
3. item 3

Unordered list

- item 1
- item 2
- item 3


Definition Lists
----------------


term 1
    Definition 1.

term 2
    Definition 2, paragraph 1.

    Definition 2, paragraph 2.


Admonitions
-----------

.. note::

    An admonition note !

This is a link to `Jupyter website <jupyter.org>`__

Code (title 2)
--------------

.. code::

    from package import module
    module.call("string")

Math
----

Math should both work as standalone formulas that takes a block:


.. math::

    \\pi = 3.14159

More complex formula:

.. math::

    \\int_0^\\infty f(\\delta v) \\partial v

.. math::

    \\nabla^2X = \\vec {rot} (\\vec {rot}(X)) = \\vec{grad}(div(X))  - \\Delta X


But should be also available in inline context, for example we know that
:math:`\\pi^2 \\simeq 10`, and that :math:`1+1=10` when counting in binary.

Literal Blocks (verbatim)
-------------------------

::

    This should be a verb-
    -batim block


This is a Transition:

-----

This is a block quote, to do, we know that Attributions are not supported right now.

    "We have weaponed the Tab Key"



Substitutions
~~~~~~~~~~~~~

In this paragraph: |SubstitutionRef| Should be replaced...

.. |SubstitutionDef| replace:: ASUBSTITUTIONDEF



Citation references
~~~~~~~~~~~~~~~~~~~

Citation references link inline mentions to a matching bibliographic
citation defined elsewhere in the document, typically at the bottom of a
docstring. A reference looks like [CIT2002]_, and multiple references such
as [Smith2020]_ and [Jones1999]_ can appear in the same paragraph. Labels
follow the RST "simple reference name" rule (letters, digits, hyphens).

.. [CIT2002] Example citation 2002, authors, title, year.
.. [Smith2020] Smith, J. 2020, "A study of citations in documentation".
.. [Jones1999] Jones, K. 1999, "On the nature of footnotes and citations".



Quotes
------

Quotes are not implemented yet in the parser, this section below will appear
empty

----

|    That which is static and repetitive is boring. That which is dynamic
|    and random is confusing. In between lies art.
|    --- *John A. Locke*

|    Science is a differential equation. Religion is a boundary condition.
|    --- *Alan Turing*

----


Directive
---------

Please have a look at the source to see the custom directives.
The file  ``example/papyri.toml`` also show how to register a custom callable
for a custom directive handler::


    [global.directives]
    mydirective='papyri.examples:_mydirective_handler'



.. mydirective:: those are the **arguments**, passed as a ``string``
    :the:
    :flags:
    :and: Here
    :are: some
    :option: field

    Beyond this is the core of the directive, it will be stored as a raw string
    in the value of Directive without the leading indentation. It is the
    responsibility of the directive handler to parse the directive and return
    corresponding ast nodes for further processing.


.. mydirective::

   A second directive to play
   with the indentation level with _italic_, **bold**, are not parsed.


Nested directives:


.. warning::

    This warnings *should* contain a deprecation:

    .. deprecated:: 0.04

        This should be deprecated

        .. note::

            This is just an **example** and is not ``deprecated``.


Various test cases
==================

This paragraph should
contain a literal with a new line ``here->|
|<``, in the final output it should render properly
without the line break,
but a space.

Signature gallery
-----------------

In addition to :func:`example1`, this module exposes a small gallery of
callables covering the main kinds of Python signatures papyri has to
handle:

- :func:`simple_generator`, :func:`fibonacci` — plain synchronous generators.
- :func:`async_fetch` — an ``async def`` coroutine function.
- :func:`async_counter` — an ``async def`` *generator* (asynchronous iterator).
- :func:`positional_only`, :func:`keyword_only`, :func:`mixed_signature` —
  parameter-kind coverage (positional-only, keyword-only, all-kinds).
- :func:`higher_order` — a :class:`~collections.abc.Callable` annotation.
- :class:`Patti` — a class whose methods cross-link to the functions above.

Their docstrings reference each other with ``:func:``, ``:meth:`` and
``:class:`` roles so the cross-linker has a self-contained, fully
resolvable graph to exercise.

Backtick edge cases
-------------------

Interpreted text with a trailing alphabetic suffix is technically invalid RST
(the spec requires the end-string to be followed by non-alphanumeric characters),
but it is common in scientific docstrings. The RST-correct form uses a
backslash-escaped space: ``\\`None\\`\\ s``. Papyri applies a best-effort heuristic
that splits the node into an ``InlineRole`` plus a plain ``Text`` suffix.

Examples of the pattern (rendered here so the viewer can exercise the fix):

- Returning `None`s when no data is found.
- An array of `ndarray`s stacked along axis 0.
- Pass `True`s and `False`s for boolean masks.
- Either `int`s or `float`s are accepted.

"""

from collections.abc import AsyncIterator, Callable, Iterator
from typing import Any


async def example1(
    pos: int,
    only: None,
    /,
    var: float | bool,
    args=1,
    *,
    kwarg,
    also=None,
    **kwargs,
) -> str | None:
    """
    first example.

    Examples
    --------
    >>> import matplotlib.pyplot as plt
    >>> fig, ax = plt.subplots()
    >>> ax.plot(range(10))

    And now

    >>> ax.plot(range(5, 15))
    >>> plt.show()

    """
    return "ok"


def example2():
    """
    Examples
    --------
    >>> import numpy as np
    >>> import matplotlib.pyplot as plt
    >>> from scipy.interpolate import UnivariateSpline

    >>> x = np.linspace(-3, 3, 50)
    >>> y = np.exp(-(x ** 2)) + 0.1 * np.random.randn(50)
    >>> plt.plot(x, y, "ro", ms=5)

    Use the default value for the smoothing parameter:

    >>> spl = UnivariateSpline(x, y)
    >>> xs = np.linspace(-3, 3, 1000)
    >>> plt.plot(xs, spl(xs), "g", lw=3)

    Manually change the amount of smoothing:

    >>> spl.set_smoothing_factor(0.5)
    >>> plt.plot(xs, spl(xs), "b", lw=3)
    >>> plt.show()

    """
    pass


def dummy():
    """
    I have no docs.
    """
    pass


def test_duplicate_see_also():
    """
    There are cases where see also has two identical elements

    See https://github.com/numpy/numpy/pull/19929

    See Also
    --------
    dummy, dummy

    """
    pass


def example_3():
    """
    This show that we support *emph* and **strong**.

    This will be ``verbatim``, and this is `interpreted-text`.
    Interpreted text can have domain and role ``:domain:role:`interpreted text```.

        .. directive::

            This will be a directive

    .. math::

        This will be interpreted at math.

    .. note::

        This directive will be turned into a note admonition.

    .. warning::

        This directive will be turned into a warning admonition.

    """


def example_with_citations():
    """
    Example with inline citation references.

    The body of this docstring mixes prose with citation references like
    [CIT2002]_ and [Nielsen2020]_ to exercise the parser path for the
    ``visit_citation_reference`` visitor. Multiple refs can sit in one
    paragraph ([Smith2020]_, [Jones1999]_) and be resolved to the same
    per-docstring citation list below.

    Notes
    -----
    Citation definitions use the block-level ``.. [label] text`` form.
    They currently render as placeholders until the citation block visitor
    is fully wired; references nevertheless carry the label so the viewer
    can anchor ``#cite-<label>`` links.

    .. [CIT2002] Example citation 2002, authors, title, year.
    .. [Nielsen2020] Nielsen, M. 2020, "Quantum computation and quantum
       information".
    .. [Smith2020] Smith, J. 2020, "A study of citations in documentation".
    .. [Jones1999] Jones, K. 1999, "On the nature of footnotes and
       citations".

    """
    pass


def example_backtick_suffix():
    """
    Edge cases: interpreted text with trailing alphabetic suffix.

    RST requires the closing backtick to be followed by whitespace or
    punctuation, not alphanumeric characters. Writing ```None`s`` is therefore
    invalid RST; the spec-correct form is ``\\`None\\`\\ s`` (backslash-escaped
    inline whitespace). Sphinx tolerates the invalid form via lenient parsing,
    so it is widespread in scientific docstrings.

    Papyri detects the ``word`suffix`` pattern and splits it into a styled
    ``InlineRole`` node followed by a plain ``Text`` node, rather than
    corrupting the value by replacing the stray backtick with a quote.

    Plain (no role):

    - Returns `None`s when the input is empty.
    - A list of `ndarray`s with matching shapes.
    - Both `int`s and `float`s are valid.

    With an explicit role:

    - Pass :data:`True`s or :data:`False`s.
    - A sequence of :class:`str`s is also accepted.

    Correctly written RST (backslash escape, no heuristic needed):

    - Returns `None`\\ s when the input is empty.
    - A list of `ndarray`\\ s with matching shapes.
    """
    pass


foo = object()


def annotation_with_hex_addresses(x: foo = lambda x: x):  # type: ignore [valid-type]
    """
    This function is a function for which the signature will have and hexadecimal addresse.

    It is included to show that the hex address should be normalized.
    """
    pass


def simple_generator(n: int = 5) -> Iterator[int]:
    """
    Yield integers ``0, 1, ..., n - 1``.

    A minimal synchronous generator used to exercise papyri's handling of
    ``generator function`` signatures (see :func:`inspect.isgeneratorfunction`).

    Parameters
    ----------
    n : int, optional
        Upper bound, exclusive. Defaults to ``5``.

    Yields
    ------
    int
        Successive integers starting at ``0``.

    See Also
    --------
    fibonacci : A stateful generator over the same element type.
    async_counter : The ``async def`` equivalent.
    Patti.iter_items : A generator method on :class:`Patti`.

    Examples
    --------
    >>> list(simple_generator(3))
    [0, 1, 2]

    """
    yield from range(n)


def fibonacci(limit: int) -> Iterator[int]:
    """
    Yield Fibonacci numbers strictly below ``limit``.

    Like :func:`simple_generator`, this is a plain synchronous generator;
    the state lives in local variables between ``yield`` points.

    Parameters
    ----------
    limit : int
        Stop yielding once the next term would be ``>= limit``.

    Yields
    ------
    int
        The next Fibonacci number.

    See Also
    --------
    simple_generator : A simpler counting generator.
    async_counter : An async generator yielding integers.
    higher_order : Consume the output via a :class:`~collections.abc.Callable`.

    Examples
    --------
    >>> list(fibonacci(20))
    [0, 1, 1, 2, 3, 5, 8, 13]

    """
    a, b = 0, 1
    while a < limit:
        yield a
        a, b = b, a + b


async def async_fetch(url: str, *, timeout: float = 10.0) -> bytes:
    """
    Pretend to fetch ``url`` and return its body.

    A minimal ``async def`` coroutine function used to exercise papyri's
    handling of ``coroutine function`` signatures. The body does no I/O so
    the example stays side-effect free at import time.

    Parameters
    ----------
    url : str
        Target URL. The value is ignored in this example.
    timeout : float, keyword-only, optional
        Deadline in seconds. Defaults to ``10.0``.

    Returns
    -------
    bytes
        A fixed, deterministic response body.

    See Also
    --------
    async_counter : An ``async def`` generator function (has ``yield``).
    simple_generator : The synchronous generator counterpart.
    example1 : Another async example, with a more elaborate signature.

    """
    del url, timeout
    return b"OK"


async def async_counter(n: int = 3) -> AsyncIterator[int]:
    """
    Async generator yielding ``0, 1, ..., n - 1``.

    This is an ``async def`` with a ``yield`` inside its body, which makes
    it an :func:`inspect.isasyncgenfunction`. Compare with
    :func:`simple_generator` (plain generator) and :func:`async_fetch`
    (plain coroutine function without ``yield``).

    Parameters
    ----------
    n : int, optional
        Upper bound, exclusive. Defaults to ``3``.

    Yields
    ------
    int
        Successive integers starting at ``0``.

    See Also
    --------
    simple_generator : Synchronous generator equivalent.
    async_fetch : Plain async coroutine (no ``yield``).
    Patti.aiter_items : Async generator method on :class:`Patti`.

    """
    for i in range(n):
        yield i


def positional_only(a: int, b: int, /) -> int:
    """
    Sum ``a`` and ``b``; both parameters are positional-only.

    Parameters
    ----------
    a, b : int
        Operands; cannot be passed by keyword.

    Returns
    -------
    int
        ``a + b``.

    See Also
    --------
    keyword_only : The keyword-only mirror image of this signature.
    mixed_signature : A signature that touches every ``Parameter.kind``.

    """
    return a + b


def keyword_only(*, name: str, count: int = 1) -> str:
    """
    Repeat ``name`` ``count`` times; both parameters are keyword-only.

    Parameters
    ----------
    name : str
        Value to repeat. Must be passed by keyword.
    count : int, optional
        Repetition count. Defaults to ``1``.

    Returns
    -------
    str
        ``name`` concatenated ``count`` times.

    See Also
    --------
    positional_only : Positional-only mirror of this signature.
    mixed_signature : Combined variant touching every parameter kind.

    """
    return name * count


def mixed_signature(
    a: int,
    b: int = 2,
    /,
    c: int = 3,
    *args: int,
    d: int = 4,
    **kwargs: int,
) -> int:
    """
    Sum of inputs; hits every :class:`inspect.Parameter.kind`.

    ``a, b`` are ``POSITIONAL_ONLY``; ``c`` is ``POSITIONAL_OR_KEYWORD``;
    ``args`` is ``VAR_POSITIONAL``; ``d`` is ``KEYWORD_ONLY``; ``kwargs``
    is ``VAR_KEYWORD``. Pair with :func:`positional_only` and
    :func:`keyword_only` to compare the simpler shapes.

    Parameters
    ----------
    a : int
        Positional-only, required.
    b : int, optional
        Positional-only with default.
    c : int, optional
        Positional-or-keyword with default.
    *args : int
        Extra positionals, summed.
    d : int, optional, keyword-only
        Keyword-only with default.
    **kwargs : int
        Extra keyword values, summed.

    Returns
    -------
    int
        The total.

    See Also
    --------
    positional_only : Simpler positional-only shape.
    keyword_only : Simpler keyword-only shape.
    example1 : The original exhaustive-signature example.

    """
    return a + b + c + sum(args) + d + sum(kwargs.values())


def higher_order(
    fn: Callable[[int], int],
    items: list[int],
) -> list[int]:
    """
    Apply ``fn`` to every element of ``items``.

    Demonstrates a :class:`~collections.abc.Callable` annotation. If you
    would rather consume an iterator, :func:`simple_generator` and
    :func:`fibonacci` produce the kind of stream this function maps over.

    Parameters
    ----------
    fn : Callable[[int], int]
        Unary function from ``int`` to ``int``.
    items : list of int
        Input values.

    Returns
    -------
    list of int
        ``[fn(x) for x in items]``.

    See Also
    --------
    simple_generator : A generator-based alternative input.
    fibonacci : Another integer-producing generator.

    Examples
    --------
    >>> higher_order(lambda x: x * x, [1, 2, 3])
    [1, 4, 9]

    """
    return [fn(x) for x in items]


class Patti:
    """
    Small class used to demonstrate cross-linked method docstrings.

    :class:`Patti` exposes an initialiser, an instance method, a
    generator method, an async generator method, a classmethod and a
    staticmethod. Method docstrings reference free functions such as
    :func:`simple_generator` and :func:`async_fetch` so the viewer can
    exercise ``:meth:`` ↔ ``:func:`` cross-links in both directions.

    Parameters
    ----------
    name : str
        Display name.
    items : list of int, optional
        Payload values. Defaults to an empty list.

    Attributes
    ----------
    name : str
        The value passed at construction.
    items : list of int
        The stored payload.

    See Also
    --------
    simple_generator : Standalone generator.
    higher_order : Standalone function taking a :class:`~collections.abc.Callable`.

    Examples
    --------
    >>> p = Patti("demo", items=[1, 2, 3])
    >>> p.total()
    6

    """

    def __init__(self, name: str, items: list[int] | None = None) -> None:
        self.name = name
        self.items: list[int] = list(items) if items is not None else []

    def total(self) -> int:
        """
        Return the sum of :attr:`items`.

        See Also
        --------
        Patti.iter_items : Iterate over items instead of summing.
        higher_order : Apply an arbitrary transform to each item.

        """
        return sum(self.items)

    def iter_items(self) -> Iterator[int]:
        """
        Yield each stored item in order.

        This is the method counterpart of :func:`simple_generator`.

        Yields
        ------
        int
            The next item in :attr:`items`.

        See Also
        --------
        simple_generator : The free-function equivalent.
        Patti.aiter_items : Async variant of this method.

        """
        yield from self.items

    async def aiter_items(self) -> AsyncIterator[int]:
        """
        Async version of :meth:`iter_items`.

        An ``async def`` with ``yield`` — i.e. an async generator method.

        Yields
        ------
        int
            The next item in :attr:`items`.

        See Also
        --------
        Patti.iter_items : Synchronous version.
        async_counter : Free-function async generator.

        """
        for x in self.items:
            yield x

    @classmethod
    def empty(cls, name: str = "anon") -> "Patti":
        """
        Build an empty :class:`Patti` instance.

        See Also
        --------
        Patti.__init__ : The full initialiser.

        """
        return cls(name, items=[])

    @staticmethod
    def describe() -> str:
        """
        Return a one-line description of the class.

        See Also
        --------
        Patti : The owning class.

        """
        return "Patti is a toy class for papyri examples."


def _mydirective_handler(args: str, options: dict[str, str], value: str):
    from .nodes import Paragraph, Text
    from .ts import parse

    parsed_arguments = parse(args.encode(), qa="custom directive")

    acc: list[Any] = []
    for p in parsed_arguments:
        acc.extend(p.children)

    return [
        *acc,
        Paragraph(
            [
                Text(
                    f".. custom_directive:\n    This is custom directive handler that received: \n"
                    f"    {args=}, \n"
                    f"    {options=}, \n"
                    f"    {value=}\n"
                ),
            ]
        ),
    ]
