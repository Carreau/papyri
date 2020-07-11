# warnign muliple projects are in this repo. 


install 

```
# clone this repo
# cd this repo
pip install flit
flit install --symlink
```

# 1) Autoreformat docstrings in minirst/ref.py

```
python -m minirst [--write] path-to-file.py
```


# 2) Not Sphinx

A project which is not sphinx (for current lack of a better name), it is _not meant_ to be a Sphinx replacement either
but to explore a different approach; mainly:

- Be more Python Specific; by knowing more about the language you can usually be smarter and simpler. 
- Separate documentation gathering, and building from rendering. 
  - Go from source to IR
  - From IR to final HTML – without extension execution. 
- Potentially offer a docstring reformatter (!not a linter), that can reformat docstrings automatically to follow
  numpydoc conventions.

This should hopefully allow a conda-forge-like model, where project upload their IR to a given repo, and a _single
website_ that contain multiple project documentation (without sub domains) can be build with better cross link between
project and _efficient_ page rebuild. 

This should also allow to reder documentation on _non html_ backend (think terminal), or provide documentation if
IDE (Spyder/Jupyterlab), without having to iframe it. 

## Usage

Still quite hackish for now:

$ mkdir html
$ rm htmls/*.html
$ python gen.py



