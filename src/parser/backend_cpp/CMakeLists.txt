cmake_minimum_required(VERSION 3.10)
project(svsch_backend)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Find UHDM
find_package(UHDM REQUIRED)

# Include directories
include_directories(include)
include_directories(${UHDM_INCLUDE_DIRS})

add_executable(svsch_backend src/main.cpp src/extractor.cpp)

# Link against UHDM
target_link_libraries(svsch_backend PRIVATE uhdm::uhdm)

# Add GTest for testing
include(FetchContent)
FetchContent_Declare(
  googletest
  URL https://github.com/google/googletest/archive/refs/tags/v1.14.0.tar.gz
)
# For Windows: Prevent overriding the parent project's compiler/linker settings
set(gtest_force_shared_crt ON CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(googletest)

enable_testing()

add_executable(svsch_test src/test_main.cpp src/extractor.cpp)
target_link_libraries(svsch_test PRIVATE uhdm::uhdm GTest::gtest_main)
add_test(NAME svsch_test COMMAND svsch_test)
