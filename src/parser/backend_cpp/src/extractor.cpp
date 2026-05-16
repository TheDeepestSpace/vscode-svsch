#include "extractor.hpp"
#include <uhdm/uhdm.h>
#include <uhdm/vpi_uhdm.h>
#include <uhdm/BaseClass.h>
#include <uhdm/ref_typespec.h>
#include <uhdm/struct_typespec.h>
#include <uhdm/typespec_member.h>
#include <uhdm/variables.h>
#include <uhdm/ports.h>
#include <uhdm/logic_typespec.h>
#include <uhdm/range.h>
#include <iostream>
#include <map>
#include <set>
#include <algorithm>
#include <cctype>
#include <cstring>
#include <fstream>
#include <regex>
#include <sstream>

namespace svsch {

#include "extractor_parts/helpers.inc"
#include "extractor_parts/serialization.inc"
#include "extractor_parts/modules.inc"
#include "extractor_parts/procedural.inc"
#include "extractor_parts/struct_bus.inc"
#include "extractor_parts/lookup_source.inc"
#include "extractor_parts/expressions.inc"

} // namespace svsch
