import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

pptx = Path(sys.argv[1])
with zipfile.ZipFile(pptx) as package:
    corrupt = package.testzip()
    slides = sorted(n for n in package.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', n))
    contents = []
    for name in slides:
        root = ET.fromstring(package.read(name))
        contents.append({'file': name, 'text': '\n'.join(el.text or '' for el in root.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t'))})
    presentation = ET.fromstring(package.read('ppt/presentation.xml'))
    ids = presentation.findall('.//{http://schemas.openxmlformats.org/presentationml/2006/main}sldId')
    result = {'zip_ok': corrupt is None, 'slide_count': len(slides), 'presentation_slide_count': len(ids),
              'all_slides_have_text': all(c['text'].strip() for c in contents), 'slides': contents, 'bytes': pptx.stat().st_size}
    result['pass'] = result['zip_ok'] and len(slides) == len(ids) == 6 and result['all_slides_have_text']
print(json.dumps(result, ensure_ascii=False))
