#!/usr/bin/env python3
"""Build pinned upstream apps into SDK-free, fixed-Chinese CN source packages."""
import hashlib,json,pathlib,shutil,sys,tempfile,re
from apply_attribution import apply as apply_attribution
ROOT=pathlib.Path(__file__).resolve().parents[1];LOCAL=ROOT/'localized/cauliflower'
sys.path.insert(0,str(LOCAL/'kit/tools'))
import build
from localize import localize_spec

def read(p):return json.loads(p.read_text())
def write(p,d):p.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def main():
 provenance=read(LOCAL/'provenance.json');plan=read(LOCAL/'release-plan.json');selected=sys.argv[1:] or sorted(plan)
 baseline=read(ROOT/'release/cn-localization-versions.json');repo=read(ROOT/'release/repo.json')
 with tempfile.TemporaryDirectory(prefix='mgu-cauliflower-cn-') as tmp:
  build.DIST=tmp
  for identity in selected:
   item=plan[identity];version=item['releaseVersion'];spec=read(LOCAL/'apps'/identity/'app.json')
   assert spec['version']==item['upstreamVersion']
   build.localize_spec=lambda v,l,version=version:dict(localize_spec(v,l),version=version)
   build.build(identity,'zh-CN',include_sdk=False)
   app=ROOT/'apps'/identity;app.mkdir(exist_ok=True);package=app/'package'
   old_notes=read(app/'release-notes.json') if (app/'release-notes.json').exists() else []
   old_changes=(package/'CHANGELOG.md').read_text() if (package/'CHANGELOG.md').exists() else '# Changelog\n\n## Unreleased\n'
   old_changes=re.sub(r'(?m)^## '+re.escape(version)+r'\n[\s\S]*?(?=^## |\Z)','',old_changes)
   if package.exists():shutil.rmtree(package)
   shutil.copytree(pathlib.Path(tmp)/identity/'source',package)
   shutil.rmtree(package/'node_modules',ignore_errors=True)
   for rhmi in ['rhmiData','rhmiDataStartWidget']:
    path=package/rhmi/'application.json'
    if path.exists():
     data=read(path);data['application']['uiDescriptions']=[u for u in data['application']['uiDescriptions'] if 'ID7' in u['hmi']];write(path,data)
     shutil.rmtree(package/rhmi/'uiDescriptions/ID8',ignore_errors=True)
   entry=package/'javascript/app.js';text=entry.read_text();entry.unlink();(package/'javascript/localized-entry.js').write_text("require('./app.js');\n"+text)
   runtime=package/'javascript/kit/mgu.js';runtime.write_text(runtime.read_text().replace("require('oap-sdk')",'global.__mguLocalizedSdk'))
   locale=package/'javascript/kit/locale.json';d=read(locale);d.pop('credit',None);write(locale,d)
   pkg=read(package/'package.json');pkg.update(main='javascript/localized-entry.js',mguLocalOnly=True,license='GPL-2.0-only' if identity=='doom' else 'MIT',files=['package.json','npm-shrinkwrap.json','manifest.json','permissions.json','config','javascript','rhmiData','LICENSE','NOTICE.zh-CN.md','PROVENANCE.json','CHANGELOG.md']);write(package/'package.json',pkg)
   shutil.copy2(LOCAL/'LICENSE',package/'LICENSE');shutil.copy2(LOCAL/'NOTICE.zh-CN.md',package/'NOTICE.zh-CN.md')
   if identity=='redline':shutil.copy2(LOCAL/'apps/redline/MPL-2.0.txt',package/'MPL-2.0.txt')
   for extra in ['rhmiDataStartWidget','MPL-2.0.txt']:
    if (package/extra).exists():pkg['files'].append(extra)
   write(package/'package.json',pkg)
   if identity=='doom':shutil.copy2(LOCAL/'apps/doom/LICENSE',package/'LICENSE')
   sourcefiles={str(f.relative_to(LOCAL)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((LOCAL/'apps'/identity).rglob('*')) if f.is_file()}
   write(package/'PROVENANCE.json',dict(provenance,commit=item.get('upstreamCommit',provenance['commit']),component=identity,upstreamVersion=spec['version'],releaseVersion=version,cnRevision=item['cnRevision'],adaptedSourceFilesSha256=sourcefiles))
   title=item['title'];changes=item['changes'];heading='## '+version+'\n\n'+''.join('- '+v+'\n' for v in changes)+'\n'
   if '## Unreleased\n' in old_changes:old_changes=re.sub(r'## Unreleased\n\s*','## Unreleased\n\n'+heading,old_changes,count=1)
   else:old_changes='# '+title+'\n\n## Unreleased\n\n'+heading+old_changes
   (package/'CHANGELOG.md').write_text(old_changes)
   (app/'src').mkdir(exist_ok=True);(app/'src/sdk.js').write_bytes((ROOT/'apps/warmup/src/sdk.js').read_bytes())
   write(app/'mgu-app.json',{'schema':1,'id':identity,'version':version,'tree':'package','modules':['src/sdk.js'],'sdk':['oap-sdk/src/core/OnlineApp.js','oap-sdk/src/logging/logging']})
   requires={'mgu-deploy':'0.8.18','mgu-render':'0.6.24','mgu-inputgate':'1.1.1','robertn_store':'0.9.45'}
   if identity=='redline':requires['cluster-render']='0.6.2'
   write(app/'release.json',{'build':'node ../../tools/build_localized.js','requires':requires,'uninstallable':True,'mguHmi':['ID7']})
   write(app/'release-notes.json',[{'version':version,'upstreamVersion':spec['version'],'cnRevision':item['cnRevision'],'changes':changes}]+[n for n in old_notes if n['version']!=version][:15])
   baseline['components'][identity]=version
   apply_attribution(identity)
   for catalog in (ROOT/'release/texts').glob('*.json'):
    texts=read(catalog);texts[identity]={'title':title,'description':item['description']} if catalog.stem=='zh-CN' else {'title':spec['title']+' (简体中文)','description':'Simplified Chinese edition. '+item['englishDescription']};write(catalog,texts)
 repo['unprefixedAppIds']=sorted(set(repo['unprefixedAppIds'])|set(selected));write(ROOT/'release/repo.json',repo)
 baseline['purpose']='Pinned cauliflowermossgrape application set with CN compatibility fixes';baseline['applicationSourceCommit']=provenance['commit'];write(ROOT/'release/cn-localization-versions.json',baseline)
if __name__=='__main__':main()
