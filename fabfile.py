# -*- coding: utf-8 -*-
# (c) 2013-2016 Andreas Motl, Elmyra UG
import os
from distutils.core import run_setup
from fabric.contrib.project import rsync_project
from fabric.decorators import task, hosts
from fabric.colors import yellow, red
from fabric.utils import abort
from fabric.state import env
from cuisine import run, file_exists, file_is_dir, file_is_file, file_upload
from pip.utils import ask

env.colorize_errors = True
env.confirm = False

# TODO: Task for uploading package file
# TODO: Task for uploading configuration file

@task
@hosts('root@almera.elmyra.de')
def install(version, target):

    if not target:
        abort('Task argument "target" is required.')

    current_dir = os.path.dirname(__file__)
    project_path = os.path.join(current_dir, 'elmyra.ip.access.epo')
    pkg_version = setuptools_get_version(project_path)
    pkg_name = setuptools_get_name(project_path)

    if not version:
        version = pkg_version

    print 'Installing package {0}, version {1} to target {2}.'.format(*map(yellow, [pkg_name, version, target]))
    if env.confirm:
        response = ask('Proceed (y/n)? ', ('y', 'n'))
    else:
        response = 'y'

    if response == 'y':

        source_package = '/root/install/ops-chooser/elmyra.ip.access.epo-{version}.tar.gz'.format(version=version)
        source_config = './elmyra.ip.access.epo/production.ini.tpl'

        target_path = '/opt/elmyra/patentsearch/sites/' + target
        venv_path = target_path + '/.venv27'

        if not file_is_file(source_package):
            abort('Source package does not exist: ' + source_package)

        if not file_is_dir(target_path):
            abort('Target path does not exist: ' + target_path)

        if not file_is_dir(venv_path):
            run('virtualenv --no-site-packages "{0}"'.format(venv_path))
            #setup_package('which', venv_path)
            # TODO: put these packages to a more convenient location

        setup_package('/root/install/ops-chooser/which*', venv_path)
        setup_package('/root/install/ops-chooser/js.*', venv_path)
        setup_package('/root/install/ops-chooser/fanstatic*', venv_path)
        setup_package(source_package, venv_path)

        upload_config(source_config, target_path)

        restart_service(target)

    else:
        print yellow('Skipped package install due to user request.')

def setup_package(package, virtualenv, options=''):
    #--index-url=http://c.pypi.python.org/simple
    pip_cmd_template = """
        source {virtualenv}/bin/activate;
        sh -c "pip install --download-cache=/var/cache/pip --allow-all-external --allow-unverified=which --verbose {options} {package}"
        """
    run(pip_cmd_template.format(**locals()))

def upload_config(config_path, target_path):
    file_upload(target_path, config_path)

def restart_service(target):
    uwsgi_names = {
        'develop':      'patentsearch-develop',
        'staging':      'patentsearch-staging',
        'prod':         'patentsearch-prod',
        'patoffice':    'patentsearch.patoffice',
        'vdpm':         'patentsearch.vdpm',
    }
    uwsgi_name = uwsgi_names.get(target, target)
    if uwsgi_name:
        run('service uwsgi reload %s' % uwsgi_name)
    else:
        print(red('WARNING: Could not restart service "%s"' % target))

@task
@hosts('root@almera.elmyra.de')
def upload_nginx_auth():
    rsync_project('/opt/elmyra/patentsearch', './nginx-auth')

def setuptools_get_version(project_path):
    setup_script = os.path.join(project_path, 'setup.py')
    # stop_after=('init', 'config', 'commandline', 'run')
    distribution_info = run_setup(setup_script, stop_after="commandline")
    return distribution_info.get_version()

def setuptools_get_name(project_path):
    setup_script = os.path.join(project_path, 'setup.py')
    # stop_after=('init', 'config', 'commandline', 'run')
    distribution_info = run_setup(setup_script, stop_after="commandline")
    return distribution_info.get_name()
